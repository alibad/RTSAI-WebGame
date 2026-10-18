/** Keep every earlier battle. A full device must fail the new save, never erase somebody else's progress. */
export function retainBattle<T extends { id: string; thumb?: string }>(record: T, previous: T[], persist: (records: T[]) => void) {
  const others = previous.filter(r => r.id !== record.id);
  try { persist([record, ...others]); }
  catch {
    const plain = { ...record };
    delete plain.thumb;
    try { persist([plain, ...others]); }
    catch { throw Error('This device is out of space for saves. Export a backup and free some space, then try again. Your earlier battles have been kept.'); }
  }
}
