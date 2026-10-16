#!/usr/bin/env python3
"""Back up local RTS AI history, working files and the accepted web build. Never pushes."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

WORKSPACE = Path(__file__).resolve().parents[2]
REPOS = ['OpenRA', 'OpenRA-AI', 'OpenRA-RL', 'RTSAI-Art', 'RTSAI-Film', 'RTSAI-Mod', 'RTSAI-Web', 'RTSAI-WebGame']

def git(repo, *args, check=True):
    return subprocess.run(['git', '-C', str(repo), *args], capture_output=True, check=check).stdout

def sha(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def save(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')

def snapshot(name, out):
    repo = WORKSPACE / name
    dest = out / name
    dest.mkdir(parents=True)
    head = git(repo, 'rev-parse', 'main').decode().strip()
    branch = git(repo, 'branch', '--show-current').decode().strip()
    refs = git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads').decode().splitlines()
    outside = [ref for ref in refs if subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', ref.split()[1], 'main'], capture_output=True).returncode]
    bundle = dest / (name + '.bundle')
    git(repo, 'bundle', 'create', str(bundle), '--all')
    verification = subprocess.run(['git', '-C', str(repo), 'bundle', 'verify', str(bundle)], capture_output=True, text=True, check=True)
    (dest / 'bundle-verify.txt').write_text(verification.stdout + verification.stderr, encoding='utf-8')
    records = []
    for index, block in enumerate(git(repo, 'worktree', 'list', '--porcelain').decode().strip().split('\n\n')):
        entries = dict(line.split(' ', 1) for line in block.splitlines() if ' ' in line)
        checkout = Path(entries['worktree'])
        record = dict(path=str(checkout), head=entries.get('HEAD'), exists=checkout.exists())
        if checkout.exists() and (checkout / '.git').exists():
            target = dest / ('working-' + str(index))
            target.mkdir()
            record['status'] = git(checkout, 'status', '--porcelain').decode()
            (target / 'tracked.patch').write_bytes(git(checkout, 'diff', '--binary', 'HEAD'))
            (target / 'staged.patch').write_bytes(git(checkout, 'diff', '--binary', '--cached'))
            untracked = git(checkout, 'ls-files', '--others', '--exclude-standard', '-z').decode().split('\0')
            record['untracked'] = []
            for rel in filter(None, untracked):
                file = checkout / rel
                if file.is_file():
                    copy = target / 'untracked' / rel
                    copy.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(file, copy)
                    record['untracked'].append(dict(path=rel, sha256=sha(copy)))
            # Generated caches can be enormous; retain their paths without confusing them with source backups.
            ignored = git(checkout, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory').decode().splitlines()
            save(target / 'ignored-paths.json', ignored)
        records.append(record)
    owner = 'fork' if name == 'OpenRA' else 'origin'
    remote = git(repo, 'rev-parse', owner + '/main', check=False).decode().strip()
    report = dict(repo=name, branch=branch, head=head, ownerMain=remote, localBranchesOutsideMain=outside, worktrees=records, bundle=str(bundle), bytes=bundle.stat().st_size, sha256=sha(bundle), verified=True)
    save(dest / 'inventory.json', report)
    print(f'{name}: verified full bundle, {len(refs)} branches, {len(records)} checkout records, {len(outside)} outside main', flush=True)
    return report

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--build-receipt', type=Path)
    parser.add_argument('--previous-recovery', type=Path)
    parser.add_argument('--launcher-registration', type=Path)
    args = parser.parse_args()
    out = args.out.resolve()
    if out.exists():
        raise ValueError('Use a new backup folder; existing backups are never replaced')
    out.mkdir(parents=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        reports = list(pool.map(lambda name: snapshot(name, out), REPOS))
    for parent in ['OpenRA-AI', 'OpenRA-RL']:
        modules = git(WORKSPACE / parent, 'config', '--file', '.gitmodules', '--get-regexp', r'^submodule\..*\.path$', check=False).decode().splitlines()
        for index, module in enumerate(modules):
            nested = WORKSPACE / parent / module.split(' ', 1)[1]
            if (nested / '.git').exists():
                bundle = out / (parent + f'-nested-{index}.bundle')
                git(nested, 'bundle', 'create', str(bundle), '--all')
                git(nested, 'bundle', 'verify', str(bundle))
    if args.previous_recovery:
        shutil.copytree(args.previous_recovery, out / 'previous-recovery')
        print('Preserved previous recovery copies, patches and raw files', flush=True)
    if args.build_receipt:
        receipt = json.loads(args.build_receipt.read_text(encoding='utf-8-sig'))
        for entry in receipt['checksums']:
            original = Path(entry['path'])
            relative = original.resolve().relative_to(args.build_receipt.parent.resolve())
            copy = out / 'accepted-web-build' / relative
            copy.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(original, copy)
            if sha(copy) != entry['sha256']:
                raise ValueError(f'Accepted build changed: {original}')
        shutil.copy2(args.build_receipt, out / 'accepted-web-build' / args.build_receipt.name)
        print(f"Accepted web build: {len(receipt['checksums'])} copies verified", flush=True)
    if args.launcher_registration:
        registration = json.loads(args.launcher_registration.read_text(encoding='utf-8-sig'))
        shutil.copy2(args.launcher_registration, out / 'launcher-registration.json')
        native = Path(registration['native'])
        for entry in registration['nativeFiles']:
            original = Path(entry['path'])
            copy = out / 'accepted-web-native' / original.relative_to(native)
            copy.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(original, copy)
            if sha(copy) != entry['sha256']:
                raise ValueError(f'Native replay dependency changed: {original}')
    for name in ['HANDOFF-CODEX.md', 'AGENTS.md']:
        shutil.copy2(WORKSPACE / name, out / name)
    save(out / 'backup.json', dict(schema=1, scope='Full Git bundles and registered working-file recovery; generated ignored caches indexed, not copied', repositories=reports, previousRecovery=str(args.previous_recovery) if args.previous_recovery else None))
    files = [dict(path=p.relative_to(out).as_posix(), bytes=p.stat().st_size, sha256=sha(p)) for p in sorted(out.rglob('*')) if p.is_file()]
    save(out / 'checksums.json', files)
    print(f'BACKUP COMPLETE: {out}, {len(files)} hashed files', flush=True)

if __name__ == '__main__':
    main()
