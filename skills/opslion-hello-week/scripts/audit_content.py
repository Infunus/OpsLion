#!/usr/bin/env python3
"""Lightweight editorial hints for Hello Week native content JSON.

Never pretends to verify source facts, actual event dates or undergraduate eligibility.
No hashes, no blocking external requests, no private API calls.
"""
import argparse
import json
import re
from pathlib import Path

SIGNUP_STATS = re.compile(r'报名人数|报名人次|报名总数|累计报名|[0-9一二三四五六七八九十百千万]+人报名')
LONG_WESTERN = re.compile(r'[A-Za-z0-9_./:%?=&#+-]{40,}')
PLACEHOLDER = re.compile(r'【待替换】|【以本期资料为准】|待填写|示例(讲座|校园|报告|学术|活动)|填写来源支持的')


def audit(data):
    """Return warnings. Explicitly leaves meaning/time/source checks to editorial review."""
    issues=[]
    if not isinstance(data,dict):
        return ['根对象应为本期内容 JSON 对象']
    if not str(data.get('title','')).strip():
        issues.append('缺少本期标题')
    if PLACEHOLDER.search(json.dumps(data,ensure_ascii=False)):
        issues.append('内容中存在示例/占位信息，正式发布前需替换或删除')
    if 'performances' in data:
        issues.append('performances 字段会被忽略；百讲演出必须保持模板预留的空白原生框')

    seen={}
    for section in ('review','upcoming','notices'):
        groups=data.get(section,[])
        if not isinstance(groups,list):
            issues.append(f'{section} 应为数组')
            continue
        normalized=[{'name':'重要提示','items':groups}] if section=='notices' else groups
        for grp in normalized:
            if not isinstance(grp,dict):
                issues.append(f'{section} 分类条目应为对象')
                continue
            if section!='notices' and not str(grp.get('name','')).strip():
                issues.append(f'{section} 中有缺少分类名的分组')
            items=grp.get('items',[])
            if not isinstance(items,list):
                issues.append(f'{section} / {grp.get("name","")} 的 items 应为数组')
                continue
            for entry in items:
                if not isinstance(entry,dict):
                    issues.append(f'{section} 中有非对象的资讯');continue
                title=str(entry.get('title','')).strip()
                if not title:
                    issues.append(f'{section} 中有无标题资讯')
                    continue
                if title in seen:
                    issues.append(f'疑似重复标题：{title}（{seen[title]} 与 {section}），请核实是否同一事件')
                else:
                    seen[title]=section
                fields=entry.get('fields') or []
                if not isinstance(fields,list):
                    issues.append(f'{title}：fields 应为数组');continue
                body=entry.get('body') or ''
                ptexts=[str(x) for x in body] if isinstance(body,list) else str(body).split('\n')
                for field in fields:
                    if not isinstance(field,(dict,str)):continue
                    value=field if isinstance(field,str) else field.get('value','')
                    label='' if isinstance(field,str) else str(field.get('label','')).strip()
                    if str(value).strip().endswith('。'):
                        issues.append(f'{title}：{label or "信息"} 字段以句号结束（生成器会去掉末尾句号）')
                    if section=='review' and (SIGNUP_STATS.search(label) or SIGNUP_STATS.search(str(value))):
                        issues.append(f'{title}：回顾含报名人数等统计，请按实际新闻价值审稿')
                for p in ptexts:
                    if p.strip().endswith('。'):
                        issues.append(f'{title}：正文段落以句号结束（生成器会去掉末尾句号）')
                    if section=='review' and SIGNUP_STATS.search(p):
                        issues.append(f'{title}：回顾正文含报名统计，请核对是否应删去')
                if not fields and not any(p.strip() for p in ptexts):
                    issues.append(f'{title}：没有实际内容，不能用空卡凑版面')
                if len(title)>32:
                    issues.append(f'{title[:40]}：长标题请检查蓝色标题条是否能正常折行')
                if len(str(body))>850:
                    issues.append(f'{title}：正文偏长，请检查自然段与手机预览')
                if LONG_WESTERN.search(str(body)+json.dumps(fields,ensure_ascii=False)):
                    issues.append(f'{title}：存在长西文连续字符，生成器可设置秀米原生西文打断')
    return list(dict.fromkeys(issues))


def main():
    parser=argparse.ArgumentParser(description='Hello Week native JSON editorial hints')
    parser.add_argument('weekly_json')
    args=parser.parse_args()
    try:
        data=json.loads(Path(args.weekly_json).read_text(encoding='utf-8'))
    except (OSError,json.JSONDecodeError) as e:
        parser.error(str(e))
    issues=audit(data)
    for item in issues:
        print('REVIEW:',item)
    print(f'本地格式/文案提示：{len(issues)} 项；事件时间、信科本科生相关性、来源真实性及最终秀米渲染仍需逐条核对')


if __name__=='__main__':
    main()
