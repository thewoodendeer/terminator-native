/**
 * Broken (audio-less) library samples to hide from the Sample Browser.
 *
 * These 62 mp3s in the "Golden Hour" playlist are corrupt R2 uploads:
 * each is an ID3 tag + cover art with NO MPEG audio stream, so the browser
 * cannot decode them (they otherwise surface as "Unable to decode audio
 * data"). Until the R2 objects are re-uploaded/removed we simply do not
 * render them. Keyed by manifest/Drive file id (BrowserEntry.id).
 *
 * Regenerate: scan every mp3 in playlists.json via a Range request on the
 * first 12 bytes — if the ID3v2 tag size (+ optional 128-byte ID3v1 trailer)
 * fills the whole object it has no audio. Full audit list also lived at
 * ~/Documents/golden-hour-broken-samples.txt.
 */
export const BROKEN_SAMPLE_IDS: ReadonlySet<string> = new Set([
  "1nNsT8Bq8W900Trxr_hVYhQU-wZGMxGIl", // Airto Moreira - The Return
  "1ePnoPHxnCl0QGO1mYivtUtrvxb6UMVfd", // Al Hudson And The Partners - Call Me
  "1BWKZfn1bKvrDavLc_QLaZBpNT_V7aeAK", // Albatross - Full Moon I [Australia] Symphonic Prog (1973)
  "1paVISXfL8-pl5BaXFn5dhDTBpfWcvc2G", // ALBERT ELMS - A, B & C
  "1gErPR5BCvOVM8OIDYUcTY2Ga0fRgZZlq", // AQUARIAN DREAM   LET ME BE THE ONE
  "15iGulgTv6fMDEFP3Ygb1R8Xk9x4zBSTT", // ARETHA FRANKLIN   ANGEL
  "140rWT0KZLdyT2tTU2wM7kWkhIwpxjcEG", // ARTHUR PRYSOCK   IN THE RAIN
  "1ckk4PdW8uoHCQ3cyRDpqutJ3IQUOoeIc", // Ball Bearing Group - Pass The Night [Italy] Library, Disco, Synthpop (
  "10CT9mm0ta_8L9fYAEKgbRuG26J05vyQd", // Carlo María Cordio - Spiral Staircases (Library, 1985)
  "12uAzCe_lmvYcAl7QGYTzY9MgwdNOoKxA", // Carlos Beltran - Cuentos Y Relatos Del Pais De Las Nieves II [Mexico] 
  "1RQ5HHNg2sCAAHdPI6_3zUCcsuBnaZcIb", // CHIKARA UEDA & THE POWER STATION - Island Cuckoo
  "1DIExEK0tIEeStYzqk1eXFqJELd4zTmLy", // Christopher Henson - Good Witch's Hour [US] Experimental Prog (1984)
  "1f1hcEA8HC3ddXCGG0t-vFE34x7js7vT7", // Claudio Roditi - Slow Fire [Brazil] Jazz, Ambient (1989)
  "1WJQHNluK-pa2BwLPjNogLLsWwmkB49fa", // Columbus Circle - The Morning After [US] Jazz (1976)
  "1nuee7S_6GI72e_0PKcJD96O8P_6kMmBs", // Dario Domingues - Ill Rivers
  "15aF_tAbjkneE2HWt5w_yduWKPNOmDjUt", // Dave Ferguson - Nina’s Journey II [US] Jazz, Ambient (1987)
  "1bPf3Fx9P2QQ561sbAhaKwa6bf5A7dzeh", // Debbie Au - Homeward [US] Soul, Easy Listening (1971)
  "1ZxcSCmbsqEIxr_QYW5HiUOFst38UEC2v", // Dino Siani Strings & Brass - Tema [Italy] Library, Easy Listening (198
  "1s9vsnN-LR4n7_kzGEjBzSngm_sILjOlC", // Don Salvatore - Angeli Negri [Italy_US] Xian Psych Lounge (197_)
  "1g-cKa_qXCMIaL3SSlH-9joMQn6dps6gF", // ELVANS ROAD LTD. - Can I
  "1VKPFh5juQk4xieEdiSJqAnGHL6xqtbRC", // Entrance - Italian Slides
  "1QbZU0g3tSa96ycqEG7KX2HzkyGO8pShM", // Fitt Band Experience - Domway [France] Soul, Afro Jazz, Dub (1996)
  "1nspZ9_4M3-tp7x62Vsaq9-zma0gEkiDB", // Fitt Band Experience - Maaro °interludes° [France] Afro Jazzy, Psych F
  "1L0RV9RHN2reLry273ZarkCWdzH8dGRgo", // Freddy Flint & Shashamane - Blue Mountain Interlude [US] Afro Jazz, Ba
  "1hqpcG2vHGfsAvCBEKABBKZUyMf1zzkmY", // Frode Thingnaes_ Axel
  "1T5PHxqOgSHHz0oPBLXk712y813gg6iYb", // Harold Alexander - Aquilla
  "1MazeVM20tW7utIllda3UPTchV_ceXrJC", // Herman Harris & The Voices Of Faith, Hope & Love - He Won't Ever Leave
  "1D0eHMFfz7g8fB24jvhu1TEsCC3TBLy03", // HOZAN YAMAMOTO & YU IMAI - Tiān yín táng shìjiàn
  "1Th550rOUgKnZUy8p1GNfGTWosQIzVIhL", // I MARC 4 - Jeane
  "1BR1PRCalxQgJEA7QL26ppNM-HfvIVdEg", // Jerry Townes - Nevermore
  "1h9otV46JKHeQmQnapkp0isFaigm1LncY", // JOE HENDERSON - Black Narcissus
  "16_73itXo5pu1VzQKm0sTAeH44R0vW337", // Jothan Callins And The Sounds Of Togetherness - Prayer For Love And Pe
  "1I7bphBtNiRrGVDxc9JEd1bnaboK2AqKO", // Make Lievonen - March For The Lonely Riders [Finland] Psych Jazz  (197
  "1LSScJdKbVXXCpQwBAm7-w8qtk81AOdAM", // Michael Bitterman - Pinelady [US] Jazz, Psych Lounge, Easy Listening (
  "1vx3-T6D5JQKhRTCV68SvDREGgo6oYgso", // Michael Cohen - Spend Your Love With Me [US] Psych Soul, Contemporary 
  "1FXfM9e0mHtbA45evtxgu0ecgtSh0XsPN", // Midnight Star - Searching For Love
  "1L8F2Fr9fbsUfWzvpdTnfXE6HYc2nsp1v", // Momentum - Remember When [US] Jazz, Easy Listening (1980)
  "1vvFQHMmRuOT_teGkHTBd3UxJUhMscf78", // NEW SUN POPS ORCHESTRA - Anohi ni kaeritai
  "1qSzhqoVJnzlH-cTKLkMTXGp_0a1JN-tU", // North Texas University Lab Band - The Continuing Adventures Of Superto
  "19ZTRAEmYiiFzMxCvkswPQnslYF2762ka", // Peter Hall - Manifestations [UK] Ambient, Psych Folk (1985)
  "1kmlj2FfuoGbvgWetCfzWRUFKNMqPd6AK", // Pino Calvi - Preludio °In MI min.° [Italy] Library, Modern Classical, 
  "1S45zxzO9ObvDatlAATQOCSWDvLYV1bgT", // Prisoner Of Love - Steve & Teresa
  "1gPBLSJpQBW6ON3tkb6L1MQFHScSkAdbo", // Rodolfo Alchourron - Arpegio
  "1jToMJe5Yt0LD7eBPk3ZzAoNt2G3DwyaF", // Ronnie Aldrich, His Pianos & Orchestra - Nadia's Theme [UK] Easy Liste
  "1AdFLLXXZPV1rkr35y8LJQNPfqkn0YIjJ", // Sadaka - Nights In Satin (Spiritual Jazz, 1982)
  "1iUFKrL5xHgyiyHrYnuPCuczqV9hmMvmx", // Shawne Jackson - The Greatest Love
  "1E5B-xr3EibP04qzuJ_95DBSzcLDOITxt", // Shirley Brown   Midnight Rendezvous (soul sample)
  "1uuUysmP1Eiu8ja1g5eP89bwPiawcIn90", // SHUNSUKE KIKUSHI - The Unfettered Shogun - VI-11
  "1l-wRPpJBA-udtP0MkDDYVmalPqW_IjIn", // SINCERELY ANTIQUE - Don't let me down
  "1lH_A6DD5p_1fB3s_mB4Z3fKuJI4TZ_EJ", // Solomon Burke - Get Out Of My Life Woman (Drum Break - Loop)
  "1ZHFe9i16MVcIH5dNOv0WVSZAo1Ho1_7T", // The Belair Strings - My Foolish Heart [Japan] Jazz, Easy Listening (19
  "1M8UGjJkqgy6-m9h73c2jsMPL-vMNemTs", // THE EAST ST. LOUIS GOSPELETTES - Have mercy on me
  "1OZGQQqD-RBfJoqllPbdSTZvx9Uc4j--5", // The Three Degrees - Lonelier Are Fools
  "1JenDNFir_vAWIP_rWTDePAZvetTDHNEp", // TOM ELLIOT - Cultures
  "1f9-fbeGlCFRsDrJhflPmDt2AhOk0kSjv", // TYRONE DAVIS   YOU DON'T HAVE TO BEG ME TO STAY
  "1SOn2APhcuFkKIkkTi1D96FLFtPNSs_ne", // Vince Guaraldi With The San Francisco Boys Chorus - Theme To Grace
  "1u-8cf_I7NsJ3q7J7aAvB5IigJPSxN2KH", // Voki Kostić & Belgrade Jazz Sextett - Admiration [Serbia_SFRY] Jazz (1
  "1QAgxlr9YXUxfDG3b7LJGiv7MiDp3XxPA", // WOLFGANG SCHLÜTER COMBO-  Sun Up
  "1TeooZIKoRLxqIHy2LfZkjpiEooyOvCo_", // Мирдза Зивере - Веришь ли ты
  "139tJEXcAMUUY9ThRkGtluEtRgWHhSenA", // 이진 Ijin - 구름은 흘러도 [South Korea] Psych, Prog (1981)
  "1KAl7EaDmIvNpcHE67FacdQ0HRTUsUcio", // シャカラ Xácara - Miyabi [Japan] Jazz, Ambient, Easy Listening (1991)
  "1gPth2iWbARxkEIslEXgsmJLdwoSXhdm9", // 安西史孝 Fumitaka Anzai - 樹魔・伝説 トラック_05再生 [Japan] Library, Psych Ambient (
]);
