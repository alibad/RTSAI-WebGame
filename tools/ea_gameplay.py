"""Original-country gameplay overlay. Retail facts are data; engine conversions live here.

Do not modify the frozen Mod input or a modern faction's shared armament in place.
"""


def restore(retail):
    E, g, b = retail.E, retail.g, retail.baseline
    facts = b['gameplay']
    countries = ', '.join(E.COUNTRIES)
    def setv(node, key, value):
        import ea_retail
        return ea_retail.set_value(E, node, key, value)
    def tr(node, key, **fields):
        import ea_retail
        return ea_retail.trait(E, node, key, **fields)
    def cell(value):
        import ea_retail
        return ea_retail.cells(value)
    def frames(value):
        # Retail's rules define a minute as 900 frames; the host runs 1500 ticks/minute.
        return round(float(value) * 25 / 15)
    def weapon(name, fallback):
        key = name.lower()
        if key not in retail.by_lower:
            source = retail.by_lower[fallback.lower()].clone()
            source.key = name
            retail.by_lower[key] = source
        result = retail._original_weapon(name)
        return next(w for w in retail.weapons if w.key.lower() == result)
    def action(w, mode, **fields):
        w.children = [n for n in w.children if n.key != 'Projectile']
        w.children.append(E.Node('Projectile', 'OriginalRa2Action',
            [E.Node('Mode', mode), *[E.Node(k, str(v)) for k, v in fields.items()]]))
    def replace_trait(patch, original, kind):
        node = original.clone()
        # Keep the inherited YAML key. The host's subtype factory adjusts per-owner
        # settings; removing/renaming here would remove the same trait twice on children.
        patch.children.append(node)
        return node

    def either(a, b):
        return f"({a}) || ({b})" if a and a != "false" else b

    g.refseq['squidgrab'] = E.Node('squidgrab', None, [E.Node(direction, None, [
        E.Node('Filename', 'sqdg_' + direction + '.shp'), E.Node('Start', '9'),
        E.Node('Length', '11'), E.Node('Tick', '100')]) for direction in ('n','ne','e','se','s','sw','w','nw')])
    retail.effects.add('squidgrab')

    for actor, a in g.cur.items():
        if actor.startswith('^') or a.get('Health') is None:
            continue
        p = E.Node(a.key)
        values = b['actors'].get(actor, {})
        # Targets can belong to any country. The attacker's original-only armament decides
        # when these dormant state machines are used (including captured enemy vehicles).
        mobile = a.get('Mobile')
        target_types = set(E.split_list(a.get('Targetable').val('TargetTypes', '') if a.get('Targetable') else ''))
        organic = values.get('Organic', '').lower() == 'yes' or 'Infantry' in target_types
        target = tr(p, 'OriginalRa2Target', Organic=str(organic).lower())
        if mobile is not None:
            tr(p, 'Mobile', PauseOnCondition=either(mobile.val('PauseOnCondition'), 'retail-temporal || retail-squid || retail-phase'))
        for key, attack in [(t.key, t) for t in a.children if t.key.startswith('Attack')]:
            tr(p, key, PauseOnCondition=either(attack.val('PauseOnCondition'), 'retail-temporal || retail-squid || retail-phase || retail-prism-support'))
        tr(p, 'DamageMultiplier@retail-temporal', Modifier=0, RequiresCondition='retail-temporal')
        if a.get('RenderSprites') is not None and a.get('BodyOrientation') is not None:
            tr(p, 'WithIdleOverlay@retail-temporal', Image='ea-explosion', Sequence='chronosk', Palette='eaeffect',
               RequiresCondition='retail-temporal')
        # Prevent ordinary death explosions/survivors when a target is erased from time.
        for item in a.children:
            if E.trait_type(item.key) in ('FireWarheadsOnDeath', 'SpawnActorOnDeath', 'SpawnSurvivors'):
                tr(p, item.key, RequiresCondition=E.both('!retail-temporal', item.val('RequiresCondition')))
        if 'Vehicle' in target_types:
            tr(p, 'Targetable@retail-vehicle', TargetTypes='RetailVehicle')
            tr(p, 'Targetable@retail-invulnerable', TargetTypes='RetailInvulnerable', RequiresCondition='invulnerability')
            tr(p, 'EdibleByLeap')
        if mobile is not None and mobile.val('Locomotor') in ('naval', 'submarine') and not organic:
            tr(p, 'Targetable@retail-ship', TargetTypes='RetailShip')
            for direction in ('n','ne','e','se','s','sw','w','nw'):
                tr(p, 'WithIdleOverlay@retail-squid-'+direction, Image='ea-squidgrab', Sequence=direction, Palette='eaunit',
                   RequiresCondition='retail-squid-'+direction)
        if organic:
            tr(p, 'ExternalCondition@INVULNERABILITY', Condition='invulnerability')
        for kind, replacement in [('GainsExperience', 'OriginalRa2Experience'),
                                   ('RepairableBuilding', 'OriginalRa2BuildingRepair'),
                                   ('RepairsUnits', 'OriginalRa2UnitRepair')]:
            original = a.get(kind)
            if original is not None:
                node = replace_trait(p, original, replacement)
                if kind == 'GainsExperience':
                    tr(p, node.key, OriginalTrainable=str(values.get('Trainable', 'yes').lower() != 'no').lower())
                if kind == 'RepairableBuilding':
                    tr(p, node.key, OriginalPercent=facts['RepairPercent'].rstrip('%'), OriginalStep=facts['RepairStep'])
                if kind == 'RepairsUnits':
                    tr(p, node.key, OriginalPercent=facts['RepairPercent'].rstrip('%'))
        if actor in g.actors:
            tr(p, 'GrantConditionOnFaction@ea-art', Condition='ea-art', Factions=countries)
            # Correct the inherited inverted healing gate, without touching modern owners.
            for key, heal in E.traits(a, 'ChangesHealth'):
                if heal.val('RequiresCondition') == 'rank-veteran && !rank-elite':
                    tr(p, key, RequiresCondition='!ea-art && rank-veteran && !rank-elite')
            heals = values.get('SelfHealing', 'no').lower() == 'yes'
            if heals or 'SELF_HEAL' in values.get('EliteAbilities', '').upper():
                tr(p, 'ChangesHealth@retail', Step=2, Delay=100, StartIfBelow=100, DamageCooldown=125,
                   RequiresCondition='ea-art' if heals else 'ea-art && rank-elite')
            # Supply omitted elite armaments using their real retail weapon definitions.
            for field, fallback_field in [('ElitePrimary', 'Primary'), ('EliteSecondary', 'Secondary')]:
                elite_name, normal_name = values.get(field), values.get(fallback_field)
                if not elite_name or not normal_name or elite_name.lower() not in b['weapons']:
                    continue
                arms = [(key, arm) for key, arm in E.traits(a, 'Armament') if arm.val('Weapon', '').lower() == normal_name.lower()]
                existing = [arm.val('Weapon', '').lower() for _, arm in E.traits(a, 'Armament')]
                if elite_name.lower() in existing:
                    continue
                for key, arm in arms:
                    base = next((x for n in retail.rules if n.key.lower() == actor.lower() for x in n.children
                                 if x.key == key.split('@')[0] + '@retail-' + (key.split('@', 1)[1] if '@' in key else 'primary')), None)
                    if base is None:
                        continue
                    # Change the already generated normal twin, so only one can fire.
                    previous = base.val('RequiresCondition')
                    setv(base, 'RequiresCondition', E.both(previous, '!rank-elite'))
                    elite = base.clone(); elite.key += '-missing-elite'
                    setv(elite, 'Name', base.val('Name') + '-elite')
                    setv(elite, 'RequiresCondition', E.both(previous, 'rank-elite'))
                    ew = weapon(elite_name, normal_name)
                    setv(elite, 'Weapon', ew.key)
                    p.children.append(elite)
                    for item in a.children:
                        if item.key.startswith('Attack'):
                            chosen = E.split_list(item.val('Armaments', 'primary, secondary'))
                            for layer in [*retail.rules, p]:
                                current = layer.get(item.key) if layer.key.lower() == actor.lower() else None
                                if current is not None and current.val('Armaments'):
                                    chosen.extend(E.split_list(current.val('Armaments')))
                            tr(p, item.key, Armaments=', '.join(dict.fromkeys([*chosen, elite.val('Name')])))
                    for body_key, body in E.traits(a, 'WithInfantryBody'):
                        sequences = body.get('AttackSequences')
                        mapping = sequences.get(arm.val('Name', 'primary')) if sequences else None
                        if mapping:
                            node = tr(p, body_key)
                            attack_map = node.get('AttackSequences')
                            if attack_map is None:
                                attack_map = E.Node('AttackSequences'); node.children.append(attack_map)
                            setv(attack_map, elite.val('Name'), mapping.value)
            # Ammo consumers must include the unique original armament names as well.
            for key, pool in E.traits(a, 'AmmoPool'):
                names = E.split_list(pool.val('Armaments', 'primary, secondary'))
                extra = [x.val('Name') for n in [*retail.rules, p] if n.key.lower() == actor.lower()
                         for x in n.children if E.trait_type(x.key) == 'Armament' and x.val('Name', '').startswith('retail-')]
                if extra:tr(p, key, Armaments=', '.join(dict.fromkeys([*names, *extra])))
        if actor == 'engineer':
            tr(p, 'OriginalRa2Defuse')
        if actor == 'dron':
            for key, priority in E.traits(a, 'AutoTargetPriority'):
                tr(p, key, ValidTargets=', '.join(dict.fromkeys([*E.split_list(priority.val('ValidTargets','Infantry')), 'RetailVehicle'])))
        if actor in ('gadept', 'nadept', 'caoutp'):
            tr(p, 'OriginalRa2ParasiteRemoval')
        if actor == 'cleg':
            original = a.get('PortableChrono')
            if original:
                tr(p, 'PortableChrono', RequiresCondition='!ea-art')
            tr(p, 'OriginalRa2ChronoMovement', RequiresCondition='ea-art', MinimumDelay=frames(facts['ChronoMinimumDelay']),
               DistanceFactor=facts['ChronoDistanceFactor'])
            tr(p, 'Mobile', RequiresCondition='!retail-phase', PauseOnCondition='chronodisable || retail-phase')
        if actor == 'atesla':
            tr(p, 'OriginalRa2PrismSupport', Range='8c0', MaxSupporters=facts['PrismSupportMax'],
               Modifier=facts['PrismSupportModifier'].rstrip('%'), Cooldown=frames(facts['PrismSupportDelay']))
        if actor == 'nairon':
            old = next(n.get('GrantExternalConditionPower@IRONCURTAIN') for n in retail.rules
                       if n.key.lower() == actor and n.get('GrantExternalConditionPower@IRONCURTAIN'))
            tr(p, old.key, RequiresCondition='!ea-art')
            node = a.get(old.key).clone(); node.key = 'OriginalRa2IronCurtainPower@retail'
            setv(node, 'RequiresCondition', 'ea-art'); setv(node, 'ValidRelationships', 'Ally, Enemy, Neutral')
            setv(node, 'Duration', frames(facts['IronCurtainDuration']));setv(node, 'Name', 'Iron Curtain')
            setv(node, 'Description', 'Make units and structures invulnerable. Infantry in the target area are destroyed.')
            setv(node, 'OrderName', 'OriginalIronCurtain');p.children.append(node)
        if actor == 'gacsph':
            tr(p, 'ChronoshiftPower@chronoshift', RequiresCondition='!ea-art')
            node = a.get('ChronoshiftPower@chronoshift').clone();node.key='OriginalRa2ChronoshiftPower@retail'
            setv(node, 'RequiresCondition', 'ea-art');setv(node, 'ChargeInterval', 10500);setv(node, 'Name', 'Chronoshift')
            setv(node, 'Description', 'Teleport units. Ground vehicles sent into water and ships sent onto land are destroyed.')
            setv(node, 'OrderName', 'OriginalChronoshift');p.children.append(node)
        if actor == 'gaweat':
            original=a.get('WeatherControlSupportPower') or next((t for t in a.children if E.trait_type(t.key)=='WeatherControlSupportPower'),None)
            if original:
                tr(p, original.key, RequiresCondition=E.both('!ea-art', original.val('RequiresCondition')))
                node=original.clone();node.key+='-retail' if '@' in node.key else '@retail'
                setv(node,'RequiresCondition','ea-art');setv(node,'Weapon','RetailLightningStorm');p.children.append(node)
        if actor == 'namisl':
            for key,power in E.traits(a,'NukePower'):
                tr(p,key,RequiresCondition=E.both('!ea-art',power.val('RequiresCondition')))
                node=power.clone();node.key+='-retail' if '@' in node.key else '@retail'
                setv(node,'RequiresCondition','ea-art');setv(node,'MissileWeapon','RetailAtomic');p.children.append(node)
        retail.rules.append(p)

    for w in list(retail.weapons):
        name=w.key.removeprefix('ea-retail-').lower()
        if name in ('neutronrifle','neutronriflee'):
            value=b['weapons'][name]
            w.children=[n for n in w.children if not n.key.startswith('Warhead')]
            action(w,'Temporal',Damage=value['Damage'])
        if name in ('ivanbomber','ivanbombere'):
            w.children=[n for n in w.children if not n.key.startswith('Warhead')]
            action(w,'IvanBomb',Damage=facts['IvanDamage'],Delay=frames(facts['IvanTimedDelay']))
        if name=='dronejump':
            setv(w,'ValidTargets','Infantry, RetailVehicle')
            setv(w,'InvalidTargets','RetailInvulnerable')
            w.children=[n for n in w.children if not n.key.startswith('Warhead')]
            action(w,'Drone',Damage=b['weapons']['dronejump']['Damage'],Interval=frames(b['weapons']['dronejump']['ROF']))
        if name in ('comet','supercomet'):
            for wh in w.children:
                if wh.value=='SpreadDamage':setv(wh,'Spread','0c1');setv(wh,'Falloff','100, 0')
            fragment='CometFragment' if name=='comet' else 'SuperCometFragment'
            weapon(fragment,'Comet')
            action(w,'Comet',Fragment='ea-retail-'+fragment.lower(),Count=b['projectiles']['LargeCometP' if name=='comet' else 'SuperCometP']['ShrapnelCount'])
        if name=='prismshot':action(w,'PrismTower')
    # Squid's parasite is a separate attack from its punch (e.g. dolphins cannot be grabbed).
    for name in ('SquidGrab','SquidGrabE'):
        w=weapon(name,'SquidPunch');setv(w,'ValidTargets','RetailShip')
        w.children=[n for n in w.children if not n.key.startswith('Warhead')]
        action(w,'Squid',Damage=b['weapons'][name.lower()]['Damage'],Interval=frames(b['weapons'][name.lower()]['ROF']))
    p=E.Node('sqd');tr(p,'AttackFrontal',Armaments='primary, secondary, retail-armament, retail-grab, retail-grab-elite')
    tr(p,'Armament@retail-grab',Name='retail-grab',Weapon='ea-retail-squidgrab',RequiresCondition='ea-art && !rank-elite')
    tr(p,'Armament@retail-grab-elite',Name='retail-grab-elite',Weapon='ea-retail-squidgrabe',RequiresCondition='ea-art && rank-elite')
    # The punch must not replace the grab against a valid ship.
    for w in retail.weapons:
        if w.key=='ea-retail-squidpunch':setv(w,'InvalidTargets','RetailShip')
    retail.rules.append(p)
    support=weapon('PrismSupport','PrismShot');support.children=[n for n in support.children if not n.key.startswith('Warhead')]
    # Elite fragments split once more, as SuperSmallCometP specifies; ordinary
    # SmallCometP terminates. Each beam damages its target, rather than a splash disk.
    for name in ('CometFragment', 'SuperCometFragment'):
        fragment = weapon(name, 'Comet')
        for wh in fragment.children:
            if wh.value == 'SpreadDamage':setv(wh,'Spread','0c1');setv(wh,'Falloff','100, 0')
        if name == 'SuperCometFragment':action(fragment,'Comet',Fragment='ea-retail-cometfragment',Count=b['projectiles']['SuperSmallCometP']['ShrapnelCount'])
    bomb=retail.by_lower['ivanbomber'].clone();bomb.key='RetailIvanExplosion'
    bomb.children=[n for n in bomb.children if n.key!='Projectile' and not n.key.startswith('Warhead')]
    wh=b['warheads']['IvanWH']
    bomb.children.append(E.Node('Warhead@damage','SpreadDamage',[
        E.Node('Damage',facts['IvanDamage']),E.Node('Spread',cell(wh['CellSpread'])),
        E.Node('Falloff','100, '+str(round(float(wh['PercentAtMax'])*100))),
        E.Node('ValidTargets','Ground, Water, Air'), E.Node('Versus',None,
            [E.Node(a,x.strip().rstrip('%')) for a,x in zip(__import__('ea_retail').ARMORS,wh['Verses'].split(','))])]))
    bomb.children.append(E.Node('Warhead@effect','CreateEffect',[E.Node('Image','explosion'),E.Node('Explosions','ivan_explosion'),E.Node('ImpactSounds','gexpcraa.wav')]))
    retail._effect_refs(bomb,'weapon');retail.weapons.append(bomb)
    for name,base in [('RetailLightningStorm','lightningstorm'),('RetailAtomic','atomic')]:
        w=retail.by_lower[base].clone();w.key=name
        if base=='lightningstorm':
            for n in w.children:
                if n.value=='CreateEffect':setv(n,'UsePlayerPalette','false')
                if n.value=='SpreadDamage':
                    setv(n,'Damage',facts['LightningDamage']);setv(n,'Spread','2c0');setv(n,'Falloff','100, 50')
        else:
            w.children=[n for n in w.children if n.value!='CreateTintedCells']
            for n in w.children:
                if n.value=='SpreadDamage':
                    setv(n,'Damage',600);setv(n,'Spread','10c0');setv(n,'Falloff','100, 2')
            w.children.append(E.Node('Warhead@retail-radiation','CreateTintedCells',[E.Node('Spread','10c0'),E.Node('Falloff','100, 2'),E.Node('Level','500'),E.Node('MaxLevel','500'),E.Node('Delay','25')]))
        retail._effect_refs(w,'weapon');retail.weapons.append(w)
