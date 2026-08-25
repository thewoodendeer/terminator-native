#pragma once
// LicenseHub — the desktop licence, Phase 8.5. The native twin of the Electron app's src/main/desktopLicense.ts,
// rule for rule:
//
//  - **Browser-only sign-in.** There is no password form in the app and no Supabase token in the page. SIGN IN
//    opens killaviccheatcodes.app in the user's own browser with a one-time nonce; the browser deep-links a
//    one-time CODE back through `terminator://auth`; the shell trades it for a long-lived, server-signed DEVICE
//    TOKEN. The nonce must match the one THIS run generated, so a forged or cold-start link completes nothing.
//  - **The token never reaches the page.** It lives in the OS store (SecretStore: Keychain / DPAPI) and the page
//    is told `{unlocked, email}` and nothing else. No OS store = the app stays signed out (fail closed), never a
//    token in the clear.
//  - **Re-validated every launch**, so a refund, a revoked purchase or a lapsed subscription re-locks the app
//    even though the device token itself is long-lived — with a **7-day offline grace** off the last successful
//    validation, so a paying user on a plane keeps working.
//
// Everything that talks to the network runs on a short-lived background thread and answers on the message
// thread. `TERMINATOR_LICENSE_FAKE` replaces the two HTTP calls with a canned answer — that is the seam the app
// probe drives the state machine through, since a gate may never depend on a real account or a live server.
#include <atomic>
#include <functional>
#include <memory>

#include <juce_gui_extra/juce_gui_extra.h>

namespace terminator::app
{

class LicenseHub
{
  public:
    using Completion = juce::WebBrowserComponent::NativeFunctionCompletion;

    LicenseHub();
    ~LicenseHub();

    /// `terminator.authSignedIn {email}` after a completed browser sign-in. Set by the shell.
    std::function<void(const juce::String& event, const juce::var& payload)> onEvent;

    /// `terminatorLicense(req)` — req.verb ∈ status · signIn · signOut · buy · token.
    /// `status` answers {ok, unlocked, email, offline, storeAvailable} and may take a network round trip.
    void handle(const juce::var& req, Completion complete);

    /// A `terminator://auth?code=…&state=…` link. True when it was ours (whether or not it signed anyone in —
    /// a bad nonce is silent, exactly as in the Electron app: the app stays locked and the user can retry).
    bool handleDeepLink(const juce::String& url);

    /// The device token for a KCC call the SHELL makes on the page's behalf (cloud presets, later). Never
    /// answered to the page.
    juce::String deviceToken() const;

  private:
    struct Stored
    {
        juce::String token, email;
        juce::int64 lastValidatedAt = 0;
    };
    struct Result
    {
        bool unlocked = false;
        juce::String email;
        bool offline = false; // answered from the grace window rather than from the server
    };

    static juce::String baseUrl();
    static std::optional<Stored> readStored();
    static bool writeStored(const Stored&);
    static void clearStored();
    static Result offlineGrace(const Stored&);
    /// The two HTTP calls, on a background thread. `fake` short-circuits both (probe seam).
    static Result checkNow();
    static bool exchangeCode(const juce::String& code, const juce::String& state, juce::String& emailOut);

    juce::String pendingNonce_; // the ONE in-flight sign-in, in memory only
    std::shared_ptr<std::atomic<bool>> alive_{std::make_shared<std::atomic<bool>>(true)};

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(LicenseHub)
};

} // namespace terminator::app
