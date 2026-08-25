#include "CloudPresets.h"

namespace terminator::app
{
namespace
{
constexpr int kTimeoutMs = 20000;

juce::var obj()
{
    return juce::var(new juce::DynamicObject());
}
void put(juce::var& o, const char* k, const juce::var& v)
{
    o.getDynamicObject()->setProperty(k, v);
}
juce::var fail(const juce::String& error, int status = 0)
{
    auto o = obj();
    put(o, "ok", false);
    put(o, "error", error);
    if (status != 0)
        put(o, "status", status);
    return o;
}
} // namespace

CloudPresets::CloudPresets(std::function<juce::String()> token) : token_(std::move(token)) {}

CloudPresets::~CloudPresets()
{
    *alive_ = false;
}

juce::String CloudPresets::baseUrl()
{
    const auto override_ = juce::SystemStats::getEnvironmentVariable("TERMINATOR_LICENSE_BASE", {});
    return (override_.isNotEmpty() ? override_.trimCharactersAtEnd("/")
                                   : juce::String("https://killaviccheatcodes.app")) +
           "/api/terminator-presets";
}

void CloudPresets::handle(const juce::var& req, Completion complete)
{
    const auto verb = req.getProperty("verb", "list").toString();
    if (verb != "list" && verb != "save" && verb != "remove")
    {
        complete(fail("unknown verb"));
        return;
    }

    const auto token = token_ ? token_() : juce::String();
    if (token.isEmpty())
    {
        // Signed out. Refused here rather than sent: an unauthenticated request to a private endpoint is a
        // request that should never have been made, and the page gets the same 401 shape either way.
        complete(fail("not signed in", 401));
        return;
    }

    juce::String body;
    if (verb == "save")
    {
        const auto preset = req.getProperty("preset", juce::var());
        if (preset.getDynamicObject() == nullptr)
        {
            complete(fail("invalid preset"));
            return;
        }
        body = juce::JSON::toString(preset, true);
    }
    else if (verb == "remove")
    {
        const auto id = req.getProperty("id", juce::var()).toString();
        if (id.isEmpty() || id.length() > 256)
        {
            complete(fail("invalid id"));
            return;
        }
        auto o = obj();
        put(o, "id", id);
        body = juce::JSON::toString(o, true);
    }

    auto alive = alive_;
    auto done = std::make_shared<Completion>(std::move(complete));
    const auto command = verb == "list" ? juce::String("GET") : (verb == "save" ? "POST" : "DELETE");
    juce::Thread::launch(
        [alive, done, token, body, command]
        {
            int status = 0;
            juce::URL url(baseUrl());
            if (body.isNotEmpty())
                url = url.withPOSTData(body);
            auto options = juce::URL::InputStreamOptions(body.isNotEmpty() ? juce::URL::ParameterHandling::inPostData
                                                                           : juce::URL::ParameterHandling::inAddress)
                               .withExtraHeaders("Authorization: Bearer " + token +
                                                 (body.isNotEmpty() ? "\r\nContent-Type: application/json" : ""))
                               .withConnectionTimeoutMs(kTimeoutMs)
                               .withStatusCode(&status)
                               .withHttpRequestCmd(command);
            const auto stream = url.createInputStream(options);
            const auto text = stream != nullptr ? stream->readEntireStreamAsString() : juce::String();
            juce::MessageManager::callAsync(
                [alive, done, status, text, stream = stream == nullptr]
                {
                    if (!*alive)
                        return;
                    if (stream)
                    {
                        (*done)(fail("could not reach the server"));
                        return;
                    }
                    if (status < 200 || status >= 300)
                    {
                        (*done)(fail(status == 401 || status == 403 ? "not signed in" : "the server refused", status));
                        return;
                    }
                    auto o = obj();
                    put(o, "ok", true);
                    put(o, "data", juce::JSON::parse(text));
                    (*done)(o);
                });
        });
}

} // namespace terminator::app
