# Beat Finisher intro videos

Drop the two intro clips here (git-add them). They play full-screen the **first
time** the Beat Finisher is opened in a session, and the one that plays also sets
the Beat Finisher modal's theme for the rest of the session (until page reload).

| File             | Theme it selects        |
| ---------------- | ----------------------- |
| `ps2-intro.mp4`  | PS2 blue-grey theme     |
| `xbox-intro.mp4` | Xbox green theme        |

Keep these exact filenames — they're referenced from
`src/renderer/chopper/ChopperView.tsx` as
`${import.meta.env.BASE_URL}videos/<name>` (resolves to `/videos/…` on the dev
tunnel and `/terminator-app/videos/…` in the production KCC bundle).

H.264 is the safe codec for both `.mp4` and `.mov` so browsers can play them. If a
file is missing or fails to load, the intro is skipped and the modal opens anyway
(the user can also tap the video to skip immediately).
