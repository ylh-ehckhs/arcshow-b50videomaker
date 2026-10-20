import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
const {textMenuItems,bindTextContextMenu}=createRequire(import.meta.url)('../main/text-editing.cjs');

test('editable fields expose native text actions and respect Chromium edit flags',()=>{
  const editFlags={canUndo:true,canRedo:false,canCut:true,canCopy:true,canPaste:true,canSelectAll:true};
  const items=textMenuItems({isEditable:true,editFlags});
  assert.deepEqual(items.filter(i=>i.role).map(i=>i.role),['undo','redo','cut','copy','paste','selectAll']);
  assert.equal(items.find(i=>i.role==='redo').enabled,false);
  assert.equal(items.find(i=>i.role==='paste').enabled,true);
  for(const item of textMenuItems({isEditable:true}))if(item.role)assert.equal(item.enabled,false);
});

test('read-only selections expose copy without paste or edit commands',()=>{
  assert.deepEqual(textMenuItems({isEditable:false,editFlags:{canCopy:true}}),[{role:'copy',label:'复制'}]);
  assert.deepEqual(textMenuItems({isEditable:false,editFlags:{canPaste:true}}),[]);
});

test('native text context menu belongs to its originating window and does not replace row menus',()=>{
  const webContents=new EventEmitter(),win={webContents},pops=[];
  const Menu={buildFromTemplate(items){return {popup(options){pops.push({items,options});}};}};
  bindTextContextMenu(win,Menu);
  webContents.emit('context-menu',{}, {isEditable:false,editFlags:{canCopy:false}});
  assert.equal(pops.length,0);
  webContents.emit('context-menu',{}, {isEditable:true,editFlags:{canPaste:true}});
  assert.equal(pops.length,1);assert.equal(pops[0].options.window,win);
  assert.equal(pops[0].items.find(i=>i.role==='paste').enabled,true);
});
