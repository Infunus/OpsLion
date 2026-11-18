#!/usr/bin/env python3
"""Import a real, captured Xiumi native-table module from a separate v4 packet.

Keeps the target's source/pageStyle/sequence intact; appends a reference module
and remaps its native text/image slot IDs to the target blueprint. The imported
source index can then be selected in a workplan with `nativeTables`.
"""
from __future__ import annotations
import argparse,copy,sys,uuid
from pathlib import Path
from native_packet import load,save,validate,walk_native,slot_name,require,PacketError

TABLE_TYPE='paper-cp:layout/classic-table-normal'

def import_table(target, reference, index):
    validate(target);validate(reference)
    tb=target['nativeLayout']['blueprint']; rb=reference['nativeLayout']['blueprint']
    require(tb.get('adapter')==rb.get('adapter'),
            '两个原生抓取包的 adapter 不相同，不能直接拼接组件；请重新抓取兼容来源')
    require(type(index) is int and 0<=index<len(rb['modules']), 'reference-source 越界')
    module=copy.deepcopy(rb['modules'][index])
    count=sum(1 for _,x in walk_native(module) if isinstance(x,dict) and x.get('_comp',{}).get('tplId')==TABLE_TYPE)
    require(count==1,'需要从参考包选取恰好包含一个原生 classic-table-normal 的顶层模块')
    newidx=len(tb['modules'])
    require(newidx<500,'添加表格后超出插件原生模块数量上限')
    for _,node in walk_native(module):
        if isinstance(node,dict) and isinstance(node.get('_comp'),dict) and isinstance(node['_comp'].get('_$uuid'),str):
            old=node['_comp']['_$uuid'];node['_comp']['_$uuid']=old.split('-')[0]+'-'+uuid.uuid4().hex[:16]
    tb['modules'].append(module)
    for s in rb['slots']:
        if s['module']!=index:continue
        t=copy.deepcopy(s);t['module']=newidx;t['path'][0]=newidx;t['id']=slot_name(t)
        tb['slots'].append(t)
    validate(target)
    return newidx


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target',required=True,help='目标文章原生 .xiumi.json')
    parser.add_argument('--reference',required=True,help='包含原生表格的示例包')
    parser.add_argument('--reference-source',type=int,required=True,help='参考包中表格所属的原生顶层模块索引')
    parser.add_argument('--out',required=True,help='写入合并后的原生模板')
    args=parser.parse_args()
    try:
        tgt=load(args.target);ref=load(args.reference)
        idx=import_table(tgt,ref,args.reference_source)
        save(args.out,tgt)
        print(f'已导入真实原生表格模块，新的 source={idx}；模板原 sequence 保持不变')
    except PacketError as e:
        parser.exit(2,f'原生表格导入失败：{e}\n')

if __name__=='__main__':main()
