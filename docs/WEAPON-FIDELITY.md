# Weapon fidelity

How every weapon fires, flies, lands and looks, measured in the engine and held to numbers and to Red Alert 2. Started
on 20 November 2026, after the owner kept finding weapon faults by eye one at a time (the Prism "like a line", the
Apocalypse "as if it's being destroyed" and missing its target) and asked for a proper assessment instead.

## What it measures

`websim weaponaudit` (`sim/OpenRA.WebSim.Native/WeaponAudit.cs`) takes every armed unit in every country's roster, at
its first rank and at elite where that changes its guns, and fires each weapon through a real attack order at a
standard target (a Rhino, else a G.I., a power plant, a destroyer or a helicopter): at short, medium and maximum range,
in four directions, once at a target driving across, and a Prism Tower once more with two towers supporting it. The
target never fires back. Every tick it records:

- the barrel tips at each shot, and where the muzzle overlay is drawn, how big against the unit;
- every projectile and beam: its start, its path, where it was sent and where it ended, how long it was drawn;
- for beams, the light the page actually draws (from the same captured draw calls the snapshot sends), across the
  beam's middle: the peak brightness difference from grass, the width that keeps 0.25 and 0.1 of it, how white;
- every sprite effect: image, sequence, the screen rectangle of its visible pixels (not its canvas), when;
- the damage the target took.

`tools/weapon-fidelity.mjs` turns that into checks, compares each weapon with RA2 and ranks the causes:

| Check | Passes when |
|---|---|
| hits | 90% of shots at a standing target land inside its box (6 px margin) |
| hitsMoving | half of the shots at a target driving across land within 30 px of it |
| muzzleFlash | every shot flashes, where RA2's weapon plays a muzzle animation (missiles have none in RA2) |
| muzzleAtTip | the flash is drawn within 6 px of the barrel tip |
| muzzleSize | the flash covers at most 60% of the unit |
| noBlastAtShooter | no explosion is drawn on the shooter except its own shot's impact |
| impactSize | the hit's effect is at most 1.6 times the size of what RA2 draws for that damage |
| projectileVisible | a shell or missile RA2 shows is drawn for half its flight, at least 3 px |
| beamVisible, beamDuration | a laser reaches 0.25 contrast over at least 3 px and stays lit 8 ticks |
| beamDrawn | an electric bolt or rad beam draws at all (RA2's are 1 px strands, so no width rule) |
| sound | the weapon has a firing sound |
| originalPalette | an original-art shell or trail in a projectile is drawn with an original palette |

RA2's facts are in `tools/data/ra2-weapon-look.json`, read from the player's own `rules.ini` and `art.ini`: each
weapon's projectile, muzzle animation, laser flags and impact list, each animation's translucency and visible size,
and the generic HE, AP and SA impact lists that modern weapons are held to by kind. An original-country weapon
(`ea-retail-*`) is compared with its own RA2 weapon. RA2 picks a hit's animation from the warhead's list by damage, in
bands of 25 (ModEnc, "AnimList").

## Running it

```sh
node tools/weapon-fidelity.mjs --websim <websim.exe> --root <unpacked bundle> --out <dir>   # about 6 minutes
node tools/weapon-fidelity.mjs --raw <weaponaudit.json> --out <dir>                         # score a run again
```

It writes `weapon-fidelity.md` (the ranked causes and every finding) and `.json`, and exits with the number of
findings that are not in `tools/data/weapon-fidelity-baseline.json`. `tools/gameplay-check.mjs` runs it on every data
release, so a release cannot bring back a fixed fault or add a new one unnoticed. The baseline lists the known open
findings with their cause; remove a line when its fault is fixed (the tool says which accepted ones are gone), and
never add one to make a release pass without saying why. `--write-baseline` rewrites it from a run.

`tools/weapon-fidelity-unit-test.mjs` (the quality gate's unit list) checks the rules on made-up shots, and
`tools/test-weapon-look.py` the generator's two RA2 rules below.

## Fixed on 20 November 2026

- **Prism** (runtime): the Prism Tank, Tower, split beams and support beams drew a flat line 2-3 px wide in the owner's
  colour (brightness contrast 0.015 against grass for a blue player). `OriginalRa2Laser` draws RA2's laser: a white
  core in a wide glow of the owner's colour, added onto what it crosses, a lens flash and a hit flare (contrast 0.62,
  5.5-7.5 px). Support beams run tower to tower at firing height. The simulation is LaserZap's, field for field.
- **Impacts by damage** (generator, `tools/ea_retail.py`): 21 original weapons now draw RA2's own animation for their
  damage; the Prism Tank's hit is a grey smoke puff, not a fireball; Rhino and Grizzly shells land with RA2's small
  blast; a Kirov bomb with RA2's big one.
- **Translucent blasts** (generator): 28 original sequences RA2 draws see-through (`Translucent=yes`) were solid.
- **Original projectile art on the project's palette** (generator): a projectile that left its palette out drew its
  original sprite or trail with the project's "effect" palette. The Typhoon's torpedo bubbles (RA2's BBBLELRG) became
  red, green and yellow noise (the owner, 20 Nov: "it doesn't feel like a submarine missile"), and 11 flak shells and
  3 missile smoke trails were off too. They now use RA2's animation palette.

## Open, ranked by units (live build, 20 Nov 2026)

See the latest `weapon-fidelity.md`. The largest: modern rockets and missiles inherit the Harrier's Maverick
(150 damage, RA2's biggest blast) with 34-60 damage and keep its blast (21 units); modern tank guns inherit
`^LargeBullet`'s medium blast where RA2's AP shell draws a small one (18 units); 15 modern defences and vehicles name
no muzzle flash; the Qilin coaxial gun's flash is drawn 7-11 px off its tip on four tanks.
