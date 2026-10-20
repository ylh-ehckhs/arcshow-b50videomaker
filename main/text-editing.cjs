function textMenuItems(params){
  const flags=params.editFlags||{};
  if(params.isEditable)return [
    {role:'undo',label:'撤销',enabled:!!flags.canUndo},
    {role:'redo',label:'重做',enabled:!!flags.canRedo},
    {type:'separator'},
    {role:'cut',label:'剪切',enabled:!!flags.canCut},
    {role:'copy',label:'复制',enabled:!!flags.canCopy},
    {role:'paste',label:'粘贴',enabled:!!flags.canPaste},
    {type:'separator'},
    {role:'selectAll',label:'全选',enabled:!!flags.canSelectAll}
  ];
  if(flags.canCopy)return [{role:'copy',label:'复制'}];
  return [];
}

function bindTextContextMenu(win,Menu){
  win.webContents.on('context-menu',(_event,params)=>{
    const items=textMenuItems(params);
    if(items.length)Menu.buildFromTemplate(items).popup({window:win});
  });
}
module.exports={bindTextContextMenu,textMenuItems};
