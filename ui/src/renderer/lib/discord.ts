// The KCC Discord invite, in one place.
//
// Shared by the MPC Extractor's help menu (mpc/Help.tsx) and The Board's
// (board/sim/phone/apps/help.ts). It also exists in subscription-starter
// (utils/discordCta.ts) for the purchase emails and the /links page — two repos
// is already one more than ideal, so if this ever changes, change both.
//
// PERMANENT invite: no expiry, unlimited uses. A default Discord invite dies
// after 7 days, which would silently break every shipped build carrying it —
// and a desktop build cannot be edited after the fact the way a web page can.
export const DISCORD_INVITE = 'https://discord.gg/tGcfa8KJpe';
