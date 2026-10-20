export const IMPRESSIONS=['hikari','tairitsu','sakuya','luna'];
export const normalizeImpression=value=>IMPRESSIONS.includes(value)?value:'luna';

// The same character palette reaches the editor and the exported frames.
// Layout colours remain empty until a user explicitly overrides a component.
const palettes={
  hikari:{dusk:{bg:'#352b3c',ink:'#fff4f8',muted:'#d7bcc9',accent:'#f1b8c8',line:'#e9c5d440'},dawn:{bg:'#faf4f6',ink:'#44313e',muted:'#806371',accent:'#a6506b',line:'#ab647e38'}},
  tairitsu:{dusk:{bg:'#1c2133',ink:'#eef0fa',muted:'#aeb6cd',accent:'#b8b7e1',line:'#a8aed040'},dawn:{bg:'#f0f1f8',ink:'#30364e',muted:'#646d8a',accent:'#626a9a',line:'#68729c38'}},
  sakuya:{dusk:{bg:'#1d302c',ink:'#effaf3',muted:'#afcbbf',accent:'#a3d9bf',line:'#b0d8c440'},dawn:{bg:'#f1f8f4',ink:'#2f463c',muted:'#647f71',accent:'#4f866d',line:'#5f927b38'}},
  luna:{dusk:{bg:'#1b192b',ink:'#f2eff9',muted:'#b7afc6',accent:'#d1bfe9',line:'#d1bfe936'},dawn:{bg:'#f0edf5',ink:'#332b42',muted:'#71667f',accent:'#796091',line:'#79609133'}},
};
export function scenePalette(impression,theme='dusk'){return {...palettes[normalizeImpression(impression)][theme==='dawn'?'dawn':'dusk']};}
