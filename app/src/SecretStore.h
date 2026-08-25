#pragma once
// SecretStore — one small secret (the desktop DEVICE TOKEN, Phase 8.5) at rest, in the OS's own store.
//
// The Electron app puts the token through `safeStorage` (macOS Keychain / Windows DPAPI) and REFUSES to write
// anything when that is unavailable — never a plaintext token on disk. This is the same rule with the same two
// backends, reached directly: macOS Keychain Services (a generic-password item), Windows DPAPI
// (`CryptProtectData`, bound to the logged-in user). No third backend, so a platform without one simply reports
// `available() == false` and the app stays signed out, exactly as Electron does.
//
// The VALUE never touches the page: the shell reads it to authorise a KCC call and answers the renderer with
// {unlocked, email} only.
#include <juce_core/juce_core.h>

namespace terminator::app::secretstore
{

/// Is an OS-backed store usable on this machine? False = the app must stay signed out (fail closed).
bool available();

/// Store (or replace) the secret under `account`. False = nothing was written.
bool store(const juce::String& account, const juce::String& value);

/// Read it back, or an empty string when there is none / the store refused.
juce::String read(const juce::String& account);

/// Remove it. Missing is success — the point is that it is gone afterwards.
bool erase(const juce::String& account);

} // namespace terminator::app::secretstore
