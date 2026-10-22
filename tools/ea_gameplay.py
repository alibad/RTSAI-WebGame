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
    g.refseq['ivan-fuse'] = E.Node('ivan-fuse', None, [E.Node('stage-'+str(i), None, [
        E.Node('Filename','bombcurs.shp'), E.Node('Start',str(i*2)), E.Node('Length','2'),
        E.Node('Tick',str(round(float(facts['IvanIconFlickerRate'])*1000/15)))]) for i in range(6)])
    retail.effects.add('ivan-fuse')
    # Death frames the reference sequences get wrong. The dolphin's "die" is a TODO pointing at frames 116-129, which
    # are its blank shadow half, so it died invisibly; the squid has no death at all. Both are the frames after the
    # attack: the dolphin's last 12 drawn frames (it rolls over), the squid's last 16 (websim effectsaudit).
    dolphin = g.refseq.get('dlph')
    if dolphin is not None and dolphin.get('die') is not None:
        setv(dolphin.get('die'), 'Start', '104'); setv(dolphin.get('die'), 'Length', '12')
    squid = g.refseq.get('sqd')
    if squid is not None and squid.get('die') is None and squid.get('idle') is not None:
        die = squid.get('idle').clone(); die.key = 'die'
        die.children = [n for n in die.children if n.key != 'Facings']
        setv(die, 'Start', '280'); setv(die, 'Length', '16')
        squid.children.append(die)

    for actor, values in b['garrisons'].items():
        if actor not in g.cur or actor not in g.refseq:continue
        a=g.cur[actor];p=E.Node(actor)
        # A civilian uses frame 2 while occupied; frame 3 is rubble, never an occupant frame.
        seq=g.refseq[actor]
        occupied=seq.get('idle').clone();occupied.key='occupied'
        setv(occupied,'Start','2');setv(occupied,'Length','1')
        setv(occupied,'ShadowStart',int(seq.get('idle').val('ShadowStart','4'))+2)
        if actor=='carus02g':setv(occupied,'ShadowStart','-1') # Retail SHP has six frames, no occupied shadow.
        seq.children.append(occupied);g.images.setdefault(actor,set()).add('occupied')
        render=tr(p,'RenderSprites',Image='ea-'+actor,PlayerPalette='eaplayer')
        if a.get('RenderSprites').get('Palette') is not None:
            render.children.append(E.Node('-Palette')) # Occupied flags remap to their owner, rather than the village's fixed palette.
        tr(p,'WithSpriteBody',RequiresCondition='!retail-occupied')
        tr(p,'WithSpriteBody@occupied',Sequence='occupied',RequiresCondition='retail-occupied')
        tr(p,'Cargo',Types='RetailGarrison',MaxWeight=values.get('MaxNumberOccupants','10'),
           LoadedCondition='retail-occupied',EjectOnDeath='true',BeforeUnloadDelay=0,AfterUnloadDelay=0)
        tr(p,'OriginalRa2Garrison')
        ports=[]
        for key,value in b['garrisonArt'].get(actor,{}).items():
            if not key.startswith('MuzzleFlash'):continue
            x,y=map(int,value.split(','));ports.append(f'{round(x*1024/60+y*1024/30)},{round(-x*1024/60+y*1024/30)},0')
        if not ports:ports=['0,0,1024']
        tr(p,'AttackGarrisoned',Armaments='retail-garrison',PortOffsets=', '.join(ports),
           PortYaws=', '.join('0' for _ in ports),PortCones=', '.join('512' for _ in ports),MuzzlePalette='eaeffect')
        tr(p,'AutoTarget',ScanRadius=7,InitialStance='Defend',InitialStanceAI='Defend')
        tr(p,'AutoTargetPriority@retail-garrison',ValidTargets='Infantry, Vehicle, Structure, Water',InvalidTargets='NoAutoTarget')
        retail.rules.append(p)
        if actor+'.rubble' in g.cur:
            rubble=E.Node(actor+'.rubble');tr(rubble,'RenderSprites',Image='ea-'+actor,Palette='eaunit');retail.rules.append(rubble)

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
            for stage in range(6):
                # A fuse is a UI marker: world-space sprites can be occluded by voxel depth.
                tr(p, 'WithDecoration@retail-bomb-'+str(stage), Image='ea-ivan-fuse', Sequence='stage-'+str(stage),
                   Palette='eaeffect', Position='Top', Margin='0,-18', ValidRelationships='Ally, Enemy, Neutral',
                   RequiresSelection='false', RequiresCondition='retail-bomb-'+str(stage))
            tr(p, 'WithIdleOverlay@retail-temporal', Image='ea-explosion', Sequence='chronosk', Palette='eaeffect',
               RequiresCondition='retail-temporal')
        # Prevent ordinary death explosions/survivors when a target is erased from time.
        for item in a.children:
            if E.trait_type(item.key) in ('FireWarheadsOnDeath', 'SpawnActorOnDeath', 'SpawnSurvivors'):
                current=next((layer.get(item.key) for layer in reversed(retail.rules)
                    if layer.key.lower()==actor and layer.get(item.key) is not None),item)
                tr(p, item.key, RequiresCondition=E.both('!retail-temporal', current.val('RequiresCondition')))
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
            # Retail grants abilities by rank, not an escalating generic port bonus.
            for rank, flag_field in [('VETERAN', 'VeteranAbilities'), ('ELITE', 'EliteAbilities')]:
                flags = set(values.get(flag_field, '').upper().split(','))
                if rank == 'ELITE':flags.update(values.get('VeteranAbilities', '').upper().split(','))
                condition = 'rank-elite' if rank == 'ELITE' else 'rank-veteran && !rank-elite'
                for kind, flag, modifier in [('FirepowerMultiplier', 'FIREPOWER', 110),
                        ('DamageMultiplier', 'STRONGER', 67), ('SpeedMultiplier', 'FASTER', 120),
                        ('ReloadDelayMultiplier', 'ROF', 60), ('InaccuracyMultiplier', None, 100)]:
                    key = kind + '@' + rank
                    old = a.get(key)
                    if old:
                        tr(p, key, RequiresCondition=E.both('!ea-art', old.val('RequiresCondition')))
                    if flag in flags:
                        tr(p, key+'-retail', Modifier=modifier, RequiresCondition='ea-art && ('+condition+')')
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
        if actor in ('e1','e2'):
            tr(p, 'OriginalRa2GarrisonOrder')
            tr(p, 'Passenger', CargoCondition='retail-passenger')
            w=weapon('AlliedOccupyW' if actor=='e1' else 'SovietOccupyW', 'M60' if actor=='e1' else 'M1Carbine')
            setv(w,'Report','baocatta.wav, baocattb.wav, baocattc.wav')
            for image in set(g.actors[actor]['images'].values()):
                g.refseq[image].children.append(E.Node('retail-ucflash',None,[
                    E.Node('Filename','ucflash.shp'),E.Node('Length','*'),E.Node('Facings','1'),
                    E.Node('ShadowStart','-1'),E.Node('Tick','40'),E.Node('Offset','0,0,0')]))
            tr(p,'Armament@retail-garrison',Name='retail-garrison',Weapon=w.key,MuzzleSequence='retail-ucflash',RequiresCondition='retail-passenger')
        if actor == 'napsis':
            old=a.get('DetectCloaked')
            if old:tr(p,old.key,RequiresCondition=E.both('!ea-art',old.val('RequiresCondition')))
            tr(p,'DetectCloaked@retail',Range='15c0',RequiresCondition='ea-art && !lowpower',DetectionTypes='Cloak, Underwater')
            tr(p,'OriginalRa2PsychicSensor',RequiresCondition='ea-art && !lowpower',Range='15c0')
        if actor == 'fv':
            # Retail mode 8 is Yuri's area psychic blast, despite the CRMindControl name.
            cargo=tr(p,'Cargo');conditions=E.Node('PassengerConditions',None,[
                E.Node('yuri','ifv-psychic'),E.Node('yuripr','ifv-psychic'),
                E.Node('ccomand','ifv-hero'),E.Node('civan','ifv-ivan'),
                E.Node('ivan','ifv-ivan'),E.Node('terror','ifv-terror')]);cargo.children.append(conditions)
            for layer in [p,*retail.rules]:
                if layer.key.lower() != 'fv':continue
                for item in layer.children:
                    if E.trait_type(item.key)=='Armament' and item.val('RequiresCondition'):
                        setv(item,'RequiresCondition',E.both(item.val('RequiresCondition'),'!ifv-psychic && !ifv-ivan && !ifv-terror'))
                    if E.trait_type(item.key)=='FireWarheadsOnDeath':
                        setv(item,'RequiresCondition',E.both(item.val('RequiresCondition'),'!ifv-ivan && !ifv-terror'))
            for key,item in E.traits(a,'Armament'):
                tr(p,key,RequiresCondition=E.both('!ea-art',E.both(item.val('RequiresCondition'),'!ifv-psychic && !ifv-ivan && !ifv-terror')))
            # Only a death explosion with an original twin is switched off for the original countries: the ordinary one
            # has none, and switching it off made their IFVs vanish without a trace.
            twins={item.key for layer in [p,*retail.rules] if layer.key.lower()=='fv' for item in layer.children}
            for key,item in E.traits(a,'FireWarheadsOnDeath'):
                cond=E.both(item.val('RequiresCondition'),'!ifv-ivan && !ifv-terror')
                tr(p,key,RequiresCondition=E.both('!ea-art',cond) if key+('-retail' if '@' in key else '@retail') in twins else cond)
            tr(p,'AutoTargetPriority@retail-psychic',ValidTargets='Infantry',InvalidTargets='NoAutoTarget',RequiresCondition='ea-art && ifv-psychic')
            tr(p,'AutoTargetPriority@retail-suicide',ValidTargets='Infantry, Vehicle, Structure, Water',InvalidTargets='NoAutoTarget',RequiresCondition='ea-art && (ifv-ivan || ifv-terror)')
            for form,name,fallback in [('psychic','CRMindControl','PsiWave'),('ivan','CRNuke','CRNuke'),('terror','CRTerrorBomb','CRTerrorBomb')]:
                w=weapon(name,fallback)
                if form!='psychic':action(w,'Suicide')
                else:
                    action(w,'PsychicPulse') # Retail AreaFire centers the blast on the carrier.
                    setv(w,'ValidTargets','Infantry')
                tr(p,'Armament@retail-ifv-'+form,Name='retail-ifv-'+form,Weapon=w.key,RequiresCondition='ea-art && ifv-'+form)
            names='primary, secondary, retail-ifv-psychic, retail-ifv-ivan, retail-ifv-terror'
            for layer in retail.rules:
                if layer.key.lower()=='fv':
                    item=layer.get('AttackTurreted')
                    if item:names+=', '+item.val('Armaments','')
            tr(p,'AttackTurreted',Armaments=names.strip(', '))
            tr(p,'WithVoxelTurret@default',RequiresCondition=E.both('ea-art',E.both(g.ref['fv'].get('WithVoxelTurret@default').val('RequiresCondition'),'!ifv-psychic && !ifv-ivan && !ifv-terror')))
            tr(p,'WithVoxelTurret@hitech',RequiresCondition='ea-art && (ifv-tesla || ifv-deso || ifv-demo || ifv-chrono || ifv-psychic || ifv-ivan || ifv-terror)')
        if actor == 'dron':
            for key, priority in E.traits(a, 'AutoTargetPriority'):
                tr(p, key, ValidTargets=', '.join(dict.fromkeys([*E.split_list(priority.val('ValidTargets','Infantry')), 'RetailVehicle'])))
        if actor in ('gadept', 'nadept', 'caoutp'):
            tr(p, 'OriginalRa2ParasiteRemoval')
        if actor in ('cleg','ccomand','civan'):
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
                node=original.clone();node.key='OriginalRa2WeatherPower@retail'
                setv(node,'RequiresCondition','ea-art');setv(node,'Weapon','RetailLightningStorm')
                # This trait keeps a rational 15 Hz clock instead of rounding every interval.
                for field in ('Duration','HitDelay','ScatterDelay','Deferment'):
                    setv(node,field,facts['LightningStormDuration' if field=='Duration' else 'Lightning'+field])
                p.children.append(node)
        if actor == 'namisl':
            for key,power in E.traits(a,'NukePower'):
                tr(p,key,RequiresCondition=E.both('!ea-art',power.val('RequiresCondition')))
                node=power.clone();node.key+='-retail' if '@' in node.key else '@retail'
                setv(node,'RequiresCondition','ea-art');setv(node,'MissileWeapon','RetailAtomic')
                retail._effect_refs(node,'actor')
                if node.val('MissilePalette') == 'player':setv(node,'MissilePalette','eaplayer')
                p.children.append(node)
        retail.rules.append(p)

    for w in list(retail.weapons):
        name=w.key.removeprefix('ea-retail-').lower()
        if name in ('neutronrifle','neutronriflee','crneutronrifle'):
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
    p=E.Node('sqd');tr(p,'AttackFrontal',Armaments='primary, secondary, retail-armament, retail-armament-elite, retail-grab, retail-grab-elite')
    # No rules gave the squid a death animation; its only owners, the original countries, get the retail one.
    tr(p,'WithDeathAnimation@ea-default',UseDeathTypeSuffix='false',DeathSequencePalette='eaplayer',DeathPaletteIsPlayerPalette='true',RequiresCondition='ea-art')
    tr(p,'Armament@retail-grab',Name='retail-grab',Weapon='ea-retail-squidgrab',RequiresCondition='ea-art && !rank-elite')
    tr(p,'Armament@retail-grab-elite',Name='retail-grab-elite',Weapon='ea-retail-squidgrabe',RequiresCondition='ea-art && rank-elite')
    # The punch must not replace the grab against a valid ship.
    for w in retail.weapons:
        if w.key in ('ea-retail-squidpunch','ea-retail-squidpunche'):setv(w,'InvalidTargets','RetailShip')
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
