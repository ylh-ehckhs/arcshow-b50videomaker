export const normalize = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export const numeric = s => s === '' || s == null ? null : Number(String(s).replace(/['’,，\s]/g, ''));
export function rating(e, rule = 'v7') {
  if (e.ratingOverride != null && e.ratingOverride !== '') return numeric(e.ratingOverride);
  const x = numeric(e.score), c = numeric(e.constant);
  if (!Number.isFinite(x) || !Number.isFinite(c)) return null;
  const bonus = rule === 'v7' && ['EC','NC','HC','TC','FR','PM'].includes(e.clear) ? 2 : 0;
  // Constants have one decimal place. Combine integer terms before division.
  const c10=Math.round(c*10);
  if (Math.abs(c*10-c10)<1e-8 && Number.isInteger(x)) {
    if (x>=10000000) return Math.max(0,(c10+20+bonus)/10);
    if (x>=9800000) return Math.max(0,((c10+10+bonus)*20000+x-9800000)/200000);
    return Math.max(0,((c10+bonus)*30000+x-9500000)/300000);
  }
  const base=x>=10000000?c+2:x>=9800000?c+1+(x-9800000)/200000:c+(x-9500000)/300000;
  return Math.max(0,base+bonus/10);
}
export function ranked(p) {
  const sorted = p.entries.filter(e=>e.enabled).map(e=>({...e, rating:rating(e,p.settings.rule)})).sort((a,b)=>(b.rating??-1)-(a.rating??-1) || (b.score??0)-(a.score??0) || a.title.localeCompare(b.title));
  const seen=new Set();
  return sorted.filter(e=>{const raw=String(e.songId||e.title).normalize('NFKC');const key=(normalize(raw)||raw.trim().toLowerCase())+'|'+e.difficulty;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,p.settings.count).map((e,i)=>({...e,rank:i+1}));
}
