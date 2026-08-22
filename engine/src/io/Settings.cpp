#include "terminator/io/Settings.h"

namespace terminator
{

juce::File Settings::defaultFile()
{
    auto base = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory);
#if JUCE_MAC
    base = base.getChildFile("Application Support"); // ~/Library/Application Support/Terminator3
#endif
    return base.getChildFile("Terminator3").getChildFile("settings.json");
}

Settings::Settings(juce::File file) : file_(std::move(file)), root_(new juce::DynamicObject()) {}

bool Settings::load()
{
    if (!file_.existsAsFile())
        return false;
    juce::var parsed;
    if (juce::JSON::parse(file_.loadFileAsString(), parsed).failed() || !parsed.isObject())
        return false;
    root_ = parsed;
    return true;
}

bool Settings::save() const
{
    file_.getParentDirectory().createDirectory();
    juce::TemporaryFile tmp(file_);
    if (!tmp.getFile().replaceWithText(juce::JSON::toString(root_)))
        return false;
    return tmp.overwriteTargetFileWithTemporary();
}

juce::var Settings::get(const juce::String& path, const juce::var& fallback) const
{
    juce::var cur = root_;
    for (const auto& key : juce::StringArray::fromTokens(path, ".", ""))
    {
        if (!cur.isObject() || !cur.hasProperty(key))
            return fallback;
        cur = cur[juce::Identifier(key)];
    }
    return cur;
}

void Settings::set(const juce::String& path, const juce::var& value)
{
    auto keys = juce::StringArray::fromTokens(path, ".", "");
    if (keys.isEmpty())
        return;
    if (!root_.isObject())
        root_ = juce::var(new juce::DynamicObject());
    juce::DynamicObject* obj = root_.getDynamicObject();
    for (int i = 0; i < keys.size() - 1; ++i)
    {
        auto child = obj->getProperty(keys[i]);
        if (!child.isObject())
        {
            child = juce::var(new juce::DynamicObject());
            obj->setProperty(keys[i], child);
        }
        obj = child.getDynamicObject();
    }
    obj->setProperty(keys[keys.size() - 1], value);
}

} // namespace terminator
