# Bundled demo scores

These three PDFs ship with Sound Garden so the app has something to show on
first launch. All three compositions are long out of copyright, and each
engraving was **placed in the public domain by its typesetter** via the
[Mutopia Project](https://www.mutopiaproject.org/).

| Score | Composer | Engraved by | Mutopia reference |
| --- | --- | --- | --- |
| Prelude No. 1 in C major, BWV 846 | J. S. Bach (1685–1750) | Tobias Erbsland | Mutopia-2011/09/12-5 |
| Gymnopédie No. 1 | Erik Satie (1866–1925) | Evin Robertson | Mutopia-2014/12/14-37 |
| The Entertainer | Scott Joplin (1868–1917) | Chris Sawer | Mutopia-2016/11/25-263 |

Each file carries the Mutopia footer stating "Placed in the public domain by
the typesetter — free to distribute, modify, and perform".

They are loaded into the library on first run by `src/db/seed.ts`, and only
when the library is empty — they will never be pushed into a library you have
already started building. Delete them from the library like any other score.

To swap in different demo content, replace the PDFs here, update
`index.json`, and bump `SEED_VERSION` in `src/db/seed.ts`.
