#pragma once
// CloudPresets — your saved projects on your KCC account (Phase 8.1, the cloud half). Three calls against
// `killaviccheatcodes.app/api/terminator-presets`, authorised with the DEVICE TOKEN — which is why they live
// here in the shell and not in the page: the token never crosses that boundary (LicenseHub).
//
// A call with no token is refused HERE, without touching the network: "signed out" is a local fact, and an
// unauthenticated request to a private endpoint is a request that should never have been made.
// Every call runs on a short-lived background thread and answers on the message thread.
#include <atomic>
#include <functional>
#include <memory>

#include <juce_gui_extra/juce_gui_extra.h>

namespace terminator::app
{

class CloudPresets
{
  public:
    using Completion = juce::WebBrowserComponent::NativeFunctionCompletion;

    /// `token` is asked on every call — signing out between calls has to take effect immediately.
    explicit CloudPresets(std::function<juce::String()> token);
    ~CloudPresets();

    /// `terminatorCloud(req)` — req.verb ∈ list · save{preset} · remove{id}.
    /// Answers {ok, presets|preset} or {ok:false, status, error}.
    void handle(const juce::var& req, Completion complete);

  private:
    static juce::String baseUrl();
    std::function<juce::String()> token_;
    std::shared_ptr<std::atomic<bool>> alive_{std::make_shared<std::atomic<bool>>(true)};

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(CloudPresets)
};

} // namespace terminator::app
