#include "LicenseHub.h"

#include "SecretStore.h"

namespace terminator::app
{
namespace
{
constexpr const char* kAccountReal = "device-token";
constexpr const char* kAccountProbe = "device-token-probe"; // the fake seam never touches the real credential
constexpr juce::int64 kOfflineGraceMs = 7LL * 24 * 60 * 60 * 1000;
constexpr int kTimeoutMs = 15000;

juce::var obj()
{
    return juce::var(new juce::DynamicObject());
}
void put(juce::var& o, const char* k, const juce::var& v)
{
    o.getDynamicObject()->setProperty(k, v);
}
juce::String env(const char* name)
{
    return juce::SystemStats::getEnvironmentVariable(name, {});
}
/// The probe seam: `unlocked:<email>` · `locked` (entitlement refused — drops the token) · `offline` (the server
/// could not be reached at all) · `fail` (reachable, 5xx). Empty = talk to the real server.
///
/// ARMED BY THE ENVIRONMENT, ONLY. `TERMINATOR_LICENSE_FAKE` is what decides whether this app is running a gate
/// at all; a real launch never sets it, and nothing the page can do turns it on.
bool seamArmed()
{
    return env("TERMINATOR_LICENSE_FAKE").isNotEmpty();
}
/// Within an ARMED run the probe may move between seam states (see the `setFake` verb): the licence gate now
/// LOCKS the app, so a gate has to prove both sides — locked really locks, the offline grace really unlocks —
/// and the seam is read from the environment, which one process cannot change for itself.
juce::String& fakeOverride()
{
    static juce::String value;
    return value;
}
juce::String fakeMode()
{
    if (seamArmed() && fakeOverride().isNotEmpty())
        return fakeOverride();
    return env("TERMINATOR_LICENSE_FAKE");
}
/// Which OS-store entry this run reads and writes. A probe run gets its OWN account, so a self-test can sign in,
/// sign out and delete to its heart's content without ever touching the user's real device token.
const char* account()
{
    return fakeMode().isNotEmpty() ? kAccountProbe : kAccountReal;
}

/// A TEST RUN KEEPS ITS CREDENTIAL OUT OF THE KEYCHAIN ENTIRELY. Its own account name was not enough: the OS
/// store is shared, an item belongs to the SIGNATURE that wrote it, and a differently-signed build of this app
/// reading one it does not own raises the system's "allow access?" dialog — which in a headless run blocks the
/// process until something kills it (it hung the probe on 2026-08-25, twice, and left a dialog on screen).
/// A seam has no business in a real keychain, so it gets a file in temp instead.
juce::File fakeStoreFile()
{
    return juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("terminator-license-probe.json");
}
bool usingFakeStore()
{
    return fakeMode().isNotEmpty();
}
} // namespace

LicenseHub::LicenseHub() = default;

LicenseHub::~LicenseHub()
{
    *alive_ = false; // a network thread that outlives us answers nobody
}

juce::String LicenseHub::baseUrl()
{
    const auto override_ = env("TERMINATOR_LICENSE_BASE");
    return override_.isNotEmpty() ? override_.trimCharactersAtEnd("/") : "https://killaviccheatcodes.app";
}

std::optional<LicenseHub::Stored> LicenseHub::readStored()
{
    const auto raw = usingFakeStore() ? fakeStoreFile().loadFileAsString() : secretstore::read(account());
    if (raw.isEmpty())
        return std::nullopt;
    const auto v = juce::JSON::parse(raw);
    const auto token = v.getProperty("token", juce::var()).toString();
    if (token.isEmpty())
        return std::nullopt;
    Stored s;
    s.token = token;
    s.email = v.getProperty("email", juce::var("")).toString();
    s.lastValidatedAt = static_cast<juce::int64>(static_cast<double>(v.getProperty("lastValidatedAt", juce::var(0.0))));
    return s;
}

bool LicenseHub::writeStored(const Stored& s)
{
    if (!usingFakeStore() && !secretstore::available())
        return false; // fail closed — the Electron rule, and the reason there is no plaintext fallback
    auto o = obj();
    put(o, "token", s.token);
    put(o, "email", s.email);
    put(o, "lastValidatedAt", static_cast<double>(s.lastValidatedAt));
    const auto json = juce::JSON::toString(o, true);
    if (usingFakeStore())
        return fakeStoreFile().replaceWithText(json);
    return secretstore::store(account(), json);
}

void LicenseHub::clearStored()
{
    if (usingFakeStore())
    {
        fakeStoreFile().deleteFile();
        return;
    }
    secretstore::erase(account());
}

LicenseHub::Result LicenseHub::offlineGrace(const Stored& s)
{
    const auto age = juce::Time::currentTimeMillis() - s.lastValidatedAt;
    if (age >= 0 && age <= kOfflineGraceMs)
        return {true, s.email, true};
    return {};
}

LicenseHub::Result LicenseHub::checkNow()
{
    const auto stored = readStored();
    if (!stored)
        return {};

    const auto fake = fakeMode();
    if (fake.isNotEmpty())
    {
        if (fake.startsWith("unlocked"))
        {
            Stored next = *stored;
            const auto email = fake.fromFirstOccurrenceOf(":", false, false);
            if (email.isNotEmpty())
                next.email = email;
            next.lastValidatedAt = juce::Time::currentTimeMillis();
            writeStored(next);
            return {true, next.email, false};
        }
        if (fake == "locked")
        {
            clearStored();
            return {};
        }
        return offlineGrace(*stored); // "offline" / "fail" — unreachable, or reachable but unable to answer
    }

    int status = 0;
    const juce::URL url(baseUrl() + "/api/terminator-check");
    const auto stream = url.createInputStream(juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress)
                                                  .withExtraHeaders("Authorization: Bearer " + stored->token)
                                                  .withConnectionTimeoutMs(kTimeoutMs)
                                                  .withStatusCode(&status));
    if (stream == nullptr)
        return offlineGrace(*stored); // could not reach it at all → the grace window

    const auto body = stream->readEntireStreamAsString();
    // Reachable and definitively NOT entitled (bad/expired token, revoked, refunded) → drop it and lock.
    if (status == 401 || status == 403)
    {
        clearStored();
        return {};
    }
    if (status >= 200 && status < 300)
    {
        const auto v = juce::JSON::parse(body);
        if (static_cast<bool>(v.getProperty("unlocked", juce::var(false))))
        {
            Stored next = *stored;
            const auto email = v.getProperty("email", juce::var("")).toString();
            if (email.isNotEmpty())
                next.email = email;
            next.lastValidatedAt = juce::Time::currentTimeMillis();
            writeStored(next);
            return {true, next.email, false};
        }
        clearStored(); // reachable + unlocked:false → revoked / lapsed
        return {};
    }
    // Reachable but the server could not answer (5xx, a misconfiguration): never punish the user, never drop
    // the token — fall back to the grace window.
    return offlineGrace(*stored);
}

bool LicenseHub::exchangeCode(const juce::String& code, const juce::String& state, juce::String& emailOut)
{
    const auto fake = fakeMode();
    if (fake.isNotEmpty())
    {
        emailOut = fake.startsWith("unlocked") ? fake.fromFirstOccurrenceOf(":", false, false) : juce::String();
        if (fake == "locked" || fake == "fail")
            return false;
        Stored s;
        s.token = "fake-device-token";
        s.email = emailOut;
        s.lastValidatedAt = juce::Time::currentTimeMillis();
        return writeStored(s);
    }

    auto payload = obj();
    put(payload, "code", code);
    put(payload, "state", state);
    int status = 0;
    const auto stream = juce::URL(baseUrl() + "/api/terminator/desktop-token")
                            .withPOSTData(juce::JSON::toString(payload, true))
                            .createInputStream(juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inPostData)
                                                   .withExtraHeaders("Content-Type: application/json")
                                                   .withConnectionTimeoutMs(kTimeoutMs)
                                                   .withStatusCode(&status));
    if (stream == nullptr || status < 200 || status >= 300)
        return false;
    const auto v = juce::JSON::parse(stream->readEntireStreamAsString());
    const auto token = v.getProperty("token", juce::var("")).toString();
    if (token.isEmpty())
        return false;
    Stored s;
    s.token = token;
    s.email = v.getProperty("email", juce::var("")).toString();
    s.lastValidatedAt = juce::Time::currentTimeMillis();
    emailOut = s.email;
    return writeStored(s);
}

juce::String LicenseHub::deviceToken() const
{
    const auto s = readStored();
    return s ? s->token : juce::String();
}

void LicenseHub::handle(const juce::var& req, Completion complete)
{
    const auto verb = req.getProperty("verb", "status").toString();

    if (verb == "signIn")
    {
        // A fresh single-use nonce per attempt. In memory only: a cold-start or forged terminator:// link has
        // nothing to match and can never complete a sign-in.
        juce::Random rng(juce::Time::getHighResolutionTicks());
        juce::MemoryBlock nonce(24);
        for (int i = 0; i < 24; ++i)
            static_cast<char*>(nonce.getData())[i] = static_cast<char>(rng.nextInt(256));
        pendingNonce_ = juce::Base64::toBase64(nonce.getData(), nonce.getSize())
                            .replaceCharacter('+', '-')
                            .replaceCharacter('/', '_')
                            .removeCharacters("=");
        // The probe drives the whole callback path; a real run never opens a browser for it either.
        const auto fake = fakeMode();
        if (fake.isEmpty())
            juce::URL(baseUrl() +
                      "/desktop/terminator?desktop=1&state=" + juce::URL::addEscapeChars(pendingNonce_, true))
                .launchInDefaultBrowser();
        auto o = obj();
        put(o, "ok", true);
        if (fake.isNotEmpty())
            put(o, "nonce", pendingNonce_); // TEST SEAM ONLY — a real sign-in keeps the nonce in this process
        complete(o);
        return;
    }
    if (verb == "signOut")
    {
        pendingNonce_.clear();
        const auto cleared = usingFakeStore() ? (fakeStoreFile().deleteFile(), !fakeStoreFile().existsAsFile())
                                              : secretstore::erase(account());
        auto o = obj();
        put(o, "ok", true);
        // …and whether the credential is really GONE — the STORE's answer, never a read-back (reading a
        // foreign item can raise the OS's access dialog and hang a headless run). It can survive when the store
        // holds one written by a differently-signed build of this app, and a caller that assumed "signed out"
        // would then be measuring that leftover instead of this build.
        put(o, "cleared", cleared);
        complete(o);
        return;
    }
    if (verb == "buy" || verb == "account")
    {
        // Two different destinations for two different people: somebody who does not own it yet goes to the
        // DOWNLOAD page — it sells it AND hands an owner the DMG/EXE, which is what a person pressing GET
        // TERMINATOR inside the app actually wants; somebody who does own it goes to their KCC account. Both
        // open in the OS browser — the session cookie lives there, and the app must never navigate away from
        // itself.
        const auto path = verb == "account" ? "/account" : "/terminator/download";
        // A probe must never open a browser (the `signIn` verb already works this way), but these two URLs are
        // exactly the kind of thing that rots silently — nobody notices a wrong link until a customer clicks it
        // — so the verb still ANSWERS with the URL it would have opened, and the self-test checks both.
        if (fakeMode().isEmpty())
            juce::URL(baseUrl() + path).launchInDefaultBrowser();
        auto o = obj();
        put(o, "ok", true);
        put(o, "url", baseUrl() + path);
        complete(o);
        return;
    }
    if (verb == "setFake")
    {
        // TEST SEAM: move this run between seam states. Refused outright unless the ENVIRONMENT already armed
        // the seam, so a page can never switch a real app onto a fake licence — and it can never switch the
        // seam OFF either (an empty mode is refused), because that would point this run at the USER's real
        // device token instead of the probe's own.
        auto o = obj();
        const auto mode = req.getProperty("mode", juce::var()).toString();
        const auto known = mode.startsWith("unlocked") || mode == "locked" || mode == "offline" || mode == "fail";
        if (!seamArmed() || !known)
        {
            put(o, "ok", false);
            put(o, "error", seamArmed() ? "unknown seam mode" : "setFake is a probe-only verb");
            complete(o);
            return;
        }
        fakeOverride() = mode;
        put(o, "ok", true);
        put(o, "mode", mode);
        complete(o);
        return;
    }
    if (verb == "deepLink")
    {
        // TEST SEAM: the OS delivers these, so a headless gate has no other way in. Refused outright unless the
        // fake seam is armed, so a page can never forge a callback.
        auto o = obj();
        if (fakeMode().isEmpty())
        {
            put(o, "ok", false);
            put(o, "error", "deepLink is a probe-only verb");
            complete(o);
            return;
        }
        put(o, "ok", handleDeepLink(req.getProperty("url", juce::var()).toString()));
        complete(o);
        return;
    }
    if (verb == "status")
    {
        // The network call NEVER runs on the message thread — a stalled KCC would freeze the UI, the timer and
        // the audio device change handler with it.
        auto alive = alive_;
        auto done = std::make_shared<Completion>(std::move(complete));
        juce::Thread::launch(
            [alive, done]
            {
                const auto r = checkNow();
                const auto storeOk = usingFakeStore() || secretstore::available();
                juce::MessageManager::callAsync(
                    [alive, done, r, storeOk]
                    {
                        if (!*alive)
                            return;
                        auto o = obj();
                        put(o, "ok", true);
                        put(o, "unlocked", r.unlocked);
                        put(o, "email", r.email);
                        put(o, "offline", r.offline);
                        put(o, "storeAvailable", storeOk);
                        (*done)(o);
                    });
            });
        return;
    }

    auto o = obj();
    put(o, "ok", false);
    put(o, "error", "unknown verb");
    complete(o);
}

bool LicenseHub::handleDeepLink(const juce::String& url)
{
    if (!url.startsWithIgnoreCase("terminator://"))
        return false;
    const auto rest = url.fromFirstOccurrenceOf("://", false, false);
    if (!rest.startsWithIgnoreCase("auth"))
        return true; // ours, but not the auth callback
    const auto query = rest.fromFirstOccurrenceOf("?", false, false);
    juce::String code, state;
    for (const auto& pair : juce::StringArray::fromTokens(query, "&", ""))
    {
        const auto k = pair.upToFirstOccurrenceOf("=", false, false);
        const auto v = juce::URL::removeEscapeChars(pair.fromFirstOccurrenceOf("=", false, false));
        if (k == "code")
            code = v;
        else if (k == "state")
            state = v;
    }
    // The state MUST match the nonce THIS run generated for an in-flight sign-in.
    if (pendingNonce_.isEmpty() || state != pendingNonce_ || code.isEmpty())
    {
        pendingNonce_.clear();
        return true;
    }
    const auto nonce = pendingNonce_;
    pendingNonce_.clear(); // single use

    auto alive = alive_;
    auto* self = this;
    juce::Thread::launch(
        [alive, self, code, nonce]
        {
            juce::String email;
            const auto ok = exchangeCode(code, nonce, email);
            juce::MessageManager::callAsync(
                [alive, self, ok, email]
                {
                    if (!*alive || !ok || self->onEvent == nullptr)
                        return; // a failure leaves the app locked; the user can press SIGN IN again
                    auto o = obj();
                    put(o, "email", email);
                    self->onEvent("terminator.authSignedIn", o);
                });
        });
    return true;
}

} // namespace terminator::app
