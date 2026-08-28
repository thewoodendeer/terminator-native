#include "SecretStore.h"

#if JUCE_MAC
#include <Security/Security.h>
#elif JUCE_WINDOWS
// NOMINMAX before anything can pull windows.h in: its max/min macros turn a later std::max into a syntax error
// (MSVC C2589 — it has taken this repo's Windows job red before).
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <dpapi.h>
#endif

namespace terminator::app::secretstore
{
namespace
{
constexpr const char* kService = "Terminator 3";

#if JUCE_MAC
/// A CoreFoundation handle that releases itself (JUCE's own CFUniquePtr lives in a private header).
template <typename T> struct CFRef
{
    T ref{};
    CFRef() = default;
    explicit CFRef(T r) : ref(r) {}
    CFRef(const CFRef&) = delete;
    CFRef& operator=(const CFRef&) = delete;
    ~CFRef()
    {
        if (ref != nullptr)
            CFRelease(ref);
    }
    T get() const { return ref; }
};

CFRef<CFStringRef> cfString(const char* utf8)
{
    return CFRef<CFStringRef>(CFStringCreateWithCString(nullptr, utf8, kCFStringEncodingUTF8));
}
#endif

#if JUCE_WINDOWS
/// DPAPI writes a blob; the blob lives beside the settings file. The FILE is not the secret — the user's login
/// credentials are: another account (or another machine) cannot unprotect it.
juce::File blobFile(const juce::String& account)
{
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
        .getChildFile("Terminator3")
        .getChildFile(account + ".bin");
}
#endif
} // namespace

#if JUCE_MAC

bool available()
{
    return true; // Keychain Services is always there; a REFUSAL shows up per call below.
}

bool store(const juce::String& account, const juce::String& value)
{
    erase(account);
    const auto acc = account.toRawUTF8();
    const auto val = value.toRawUTF8();
    const void* keys[] = {kSecClass, kSecAttrService, kSecAttrAccount, kSecValueData, kSecAttrAccessible};
    CFRef<CFDataRef> data(
        CFDataCreate(nullptr, reinterpret_cast<const UInt8*>(val), static_cast<CFIndex>(std::strlen(val))));
    const auto service = cfString(kService);
    const auto accountRef = cfString(acc);
    const void* values[] = {kSecClassGenericPassword, service.get(), accountRef.get(), data.get(),
                            kSecAttrAccessibleWhenUnlocked};
    CFRef<CFDictionaryRef> query(
        CFDictionaryCreate(nullptr, keys, values, 5, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks));
    return SecItemAdd(query.get(), nullptr) == errSecSuccess;
}

juce::String read(const juce::String& account)
{
    const void* keys[] = {kSecClass, kSecAttrService, kSecAttrAccount, kSecReturnData, kSecMatchLimit};
    const auto service = cfString(kService);
    const auto accountRef = cfString(account.toRawUTF8());
    const void* values[] = {kSecClassGenericPassword, service.get(), accountRef.get(), kCFBooleanTrue,
                            kSecMatchLimitOne};
    CFRef<CFDictionaryRef> query(
        CFDictionaryCreate(nullptr, keys, values, 5, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks));
    CFTypeRef out = nullptr;
    if (SecItemCopyMatching(query.get(), &out) != errSecSuccess || out == nullptr)
        return {};
    CFRef<CFDataRef> data(static_cast<CFDataRef>(out));
    return juce::String::fromUTF8(reinterpret_cast<const char*>(CFDataGetBytePtr(data.get())),
                                  static_cast<int>(CFDataGetLength(data.get())));
}

bool erase(const juce::String& account)
{
    // A Keychain item is owned by the SIGNATURE that created it, so a differently-signed build of the same app
    // (debug vs the universal release, say) can find one it is not allowed to delete — and the caller has to be
    // told, because everything it measures afterwards would be about that leftover. What it must NOT do is
    // READ BACK to check: reading a foreign item can raise the OS's own "allow access?" dialog, which in a
    // headless run (a probe, a CI job) blocks the process until something kills it. The delete's own status is
    // the answer: only errSecSuccess and errSecItemNotFound mean the credential is gone.
    const void* keys[] = {kSecClass, kSecAttrService, kSecAttrAccount};
    const auto service = cfString(kService);
    const auto accountRef = cfString(account.toRawUTF8());
    const void* values[] = {kSecClassGenericPassword, service.get(), accountRef.get()};
    CFRef<CFDictionaryRef> query(
        CFDictionaryCreate(nullptr, keys, values, 3, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks));
    const auto st = SecItemDelete(query.get());
    return st == errSecSuccess || st == errSecItemNotFound;
}

#elif JUCE_WINDOWS

bool available()
{
    return true; // DPAPI is part of the OS; a refusal shows up per call.
}

bool store(const juce::String& account, const juce::String& value)
{
    const auto utf8 = value.toRawUTF8();
    DATA_BLOB in{static_cast<DWORD>(std::strlen(utf8)), reinterpret_cast<BYTE*>(const_cast<char*>(utf8))};
    DATA_BLOB out{};
    if (!CryptProtectData(&in, L"Terminator 3", nullptr, nullptr, nullptr, 0, &out))
        return false;
    const juce::MemoryBlock mb(out.pbData, out.cbData);
    LocalFree(out.pbData);
    const auto f = blobFile(account);
    return f.getParentDirectory().createDirectory().wasOk() && f.replaceWithData(mb.getData(), mb.getSize());
}

juce::String read(const juce::String& account)
{
    juce::MemoryBlock mb;
    const auto f = blobFile(account);
    if (!f.existsAsFile() || !f.loadFileAsData(mb) || mb.getSize() == 0)
        return {};
    DATA_BLOB in{static_cast<DWORD>(mb.getSize()), static_cast<BYTE*>(mb.getData())};
    DATA_BLOB out{};
    if (!CryptUnprotectData(&in, nullptr, nullptr, nullptr, nullptr, 0, &out))
        return {};
    const auto s = juce::String::fromUTF8(reinterpret_cast<const char*>(out.pbData), static_cast<int>(out.cbData));
    LocalFree(out.pbData);
    return s;
}

bool erase(const juce::String& account)
{
    const auto f = blobFile(account);
    return !f.existsAsFile() || f.deleteFile();
}

#else

bool available()
{
    return false; // no OS store → the app stays signed out rather than writing a token in the clear
}
bool store(const juce::String&, const juce::String&)
{
    return false;
}
juce::String read(const juce::String&)
{
    return {};
}
bool erase(const juce::String&)
{
    return true;
}

#endif

} // namespace terminator::app::secretstore
