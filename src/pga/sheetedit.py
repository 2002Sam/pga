"""Small local XLSX cell editor. Patch XML parts, preserving other ZIP members verbatim."""
from __future__ import annotations
import datetime as dt
import hashlib
import html
import io
import math
import os
from pathlib import Path
import posixpath
import re
import stat
import tempfile
import zipfile
from xml.etree import ElementTree as ET
from pga.localfiles import _save_lock

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
MAX_ROWS, MAX_COLS = 3000, 80

def coord(ref):
    m = re.fullmatch(r'([A-Z]{1,3})([1-9][0-9]{0,6})', ref or '')
    if not m: raise ValueError('无效的单元格地址')
    col = 0
    for ch in m[1]: col = col * 26 + ord(ch) - 64
    return int(m[2]), col

def inside(ref, area):
    a, _, b = area.replace('$', '').partition(':')
    r,c=coord(ref); r1,c1=coord(a);r2,c2=coord(b or a)
    return r1<=r<=r2 and c1<=c<=c2

def _archive(raw):
    z=zipfile.ZipFile(io.BytesIO(raw))
    if len(z.infolist())>10000 or sum(i.file_size for i in z.infolist())>100*1024*1024:
        raise ValueError('表格过大，请用系统应用编辑')
    if any(n.startswith('_xmlsignatures/') for n in z.namelist()):
        raise ValueError('带数字签名的表格请用系统应用编辑')
    return z

def _parts(z):
    root=ET.fromstring(z.read('xl/workbook.xml'))
    if root.find('m:workbookProtection',NS) is not None:
        raise ValueError('工作簿受保护，请用系统应用处理')
    rels={r.get('Id'):r.get('Target','') for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
    out=[]
    for s in root.findall('m:sheets/m:sheet',NS):
        t=rels.get(s.get('{'+NS['r']+'}id'),'')
        p=posixpath.normpath(t.lstrip('/') if t.startswith('/') else 'xl/'+t)
        if not p.startswith('xl/worksheets/') or p not in z.namelist(): raise ValueError('工作表路径无效')
        out.append((s.get('name'),p,s.get('state','visible')))
    return out

def _value(c,shared):
    v=c.find('m:v',NS); raw=v.text if v is not None and v.text else ''
    kind=c.get('t')
    if kind=='s': return shared[int(raw)] if raw.isdigit() and int(raw)<len(shared) else '', 'text'
    if kind=='inlineStr': return ''.join(t.text or '' for t in c.findall('.//m:t',NS)), 'text'
    if kind=='b': return raw=='1','boolean'
    if kind in ('str','e'):return raw,'text'
    if raw:
        try:
            n=float(raw)
            if math.isfinite(n):return int(n) if n.is_integer() else n,'number'
        except ValueError:pass
    return raw,'text'

def _dates(z):
    if 'xl/styles.xml' not in z.namelist(): return set()
    root=ET.fromstring(z.read('xl/styles.xml')); fmts={int(n.get('numFmtId')):n.get('formatCode','') for n in root.findall('m:numFmts/m:numFmt',NS)}
    ids=set()
    for i,x in enumerate(root.findall('m:cellXfs/m:xf',NS)):
        n=int(x.get('numFmtId','0')); f=re.sub(r'"[^"]*"|\\.|\[[^]]*\]','',fmts.get(n,'')).lower()
        if n in range(14,18) or ('y' in f and 'd' in f): ids.add(i)
    return ids

def _read(path):
    if path.suffix.lower()!='.xlsx':raise ValueError('单元格编辑目前支持 .xlsx')
    if path.stat().st_size>20*1024*1024:raise ValueError('文件超过20 MB，请用系统应用编辑')
    raw=path.read_bytes()
    return raw,hashlib.sha256(raw).hexdigest()

def snapshot(path):
    raw,version=_read(path)
    with _archive(raw) as z:
        shared=[]
        if 'xl/sharedStrings.xml' in z.namelist():
            shared=[''.join(t.text or '' for t in s.findall('.//m:t',NS)) for s in ET.fromstring(z.read('xl/sharedStrings.xml'))]
        dates=_dates(z); sheets=[]
        props=ET.fromstring(z.read('xl/workbook.xml')).find('m:workbookPr',NS)
        base=dt.datetime(1904,1,1) if props is not None and props.get('date1904') in ('1','true') else dt.datetime(1899,12,30)
        for name,part,state in _parts(z):
            root=ET.fromstring(z.read(part)); protected=root.find('m:sheetProtection',NS) is not None
            merges=[x.get('ref') for x in root.findall('m:mergeCells/m:mergeCell',NS)]
            cells={};nr=1;nc=1;truncated=False
            for c in root.findall('m:sheetData/m:row/m:c',NS):
                ref=c.get('r','');r,col=coord(ref)
                if r>MAX_ROWS or col>MAX_COLS:truncated=True;continue
                v,kind=_value(c,shared); formula=c.find('m:f',NS)
                if v=='' and formula is None: continue
                nr=max(nr,r);nc=max(nc,col)
                if kind=='number' and int(c.get('s','0')) in dates and formula is None:
                    try:v=(base+dt.timedelta(days=v)).date().isoformat();kind='date'
                    except (OverflowError,ValueError):pass
                cells[ref]={'value':v,'type':kind,**({'formula':formula.text or ''} if formula is not None else {})}
            choices=[]
            for d in root.findall('m:dataValidations/m:dataValidation',NS):
                f=d.find('m:formula1',NS);text=f.text if f is not None else ''
                if d.get('type')=='list' and text and text.startswith('"') and text.endswith('"'):
                    choices.append({'ranges':d.get('sqref','').split(),'values':text[1:-1].split(',')})
            sheets.append({'name':name,'cells':cells,'rows':nr,'cols':nc,'merges':merges,'choices':choices,'protected':protected,'hidden':state!='visible','truncated':truncated})
    return {'version':version,'mtime':str(path.stat().st_mtime_ns),'sheets':sheets,'name':path.name}

def _patch_cell(xml,root,ref,value,kind):
    c=next((x for x in root.findall('m:sheetData/m:row/m:c',NS) if x.get('r')==ref),None)
    if c is not None and c.find('m:f',NS) is not None:raise ValueError('公式单元格暂不支持修改')
    attrs=dict(c.attrib) if c is not None else {'r':ref}
    attrs.pop('t',None)
    prefix=re.search(r'<((?:[\w]+:)?)(?:worksheet)\b',xml)[1]
    if kind=='number':
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):raise ValueError('无效数字')
        inner=f'<{prefix}v>{value}</{prefix}v>'
    elif kind=='boolean':
        if not isinstance(value,bool):raise ValueError('无效布尔值')
        attrs['t']='b';inner=f'<{prefix}v>{int(value)}</{prefix}v>'
    elif kind=='text':
        if not isinstance(value,str) or len(value)>32767 or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]',value):raise ValueError('文本过长或包含非法字符')
        attrs['t']='inlineStr';inner=f'<{prefix}is><{prefix}t xml:space="preserve">{html.escape(value)}</{prefix}t></{prefix}is>'
    else:raise ValueError('不支持的单元格类型')
    attr=' '.join(f'{k}="{html.escape(v,quote=True)}"' for k,v in attrs.items())
    replacement=f'<{prefix}c {attr}>{inner}</{prefix}c>'
    cp=re.compile(r'<'+prefix+r'c\b(?=[^>]*\br=["\']'+ref+r'["\'])[^>]*(?:/>|>.*?</'+prefix+r'c>)',re.S)
    if c is not None:
        xml,n=cp.subn(lambda _:replacement,xml,count=1)
        if n!=1:raise ValueError('无法定位单元格')
        return xml
    row,col=coord(ref)
    rp=re.compile(r'(<'+prefix+r'row\b(?=[^>]*\br=["\']'+str(row)+r'["\'])[^>]*)(/>|>.*?</'+prefix+r'row>)',re.S)
    m=rp.search(xml)
    if not m:raise ValueError('请在已有行内编辑，新建行请用系统应用')
    chunk=m.group(0)
    if m[2]=='/>':changed=m[1]+'>'+replacement+f'</{prefix}row>'
    else:
        later=next((match for match in re.finditer(r'<'+prefix+r'c\b[^>]*\br=["\']([A-Z]+[0-9]+)["\']',chunk) if coord(match[1])[1]>col),None)
        at=later.start() if later else chunk.rfind(f'</{prefix}row>')
        changed=chunk[:at]+replacement+chunk[at:]
    return xml[:m.start()]+changed+xml[m.end():]

def save_cells(path,version,changes):
    if not isinstance(version,str) or not re.fullmatch('[0-9a-f]{64}',version):raise ValueError('缺少文件版本，请重新打开')
    if not isinstance(changes,list) or not 1<=len(changes)<=2000:raise ValueError('每次保存1至2000个单元格')
    with _save_lock:
        raw,current=_read(path)
        if current!=version:raise ValueError('changed')
        snapshot_info=snapshot(path); grouped={};seen=set()
        with _archive(raw) as z:
            parts={n:p for n,p,_ in _parts(z)}
            for change in changes:
                if not isinstance(change,dict):raise ValueError('修改格式无效')
                sh,ref=change.get('sheet'),change.get('cell');r,c=coord(ref)
                if sh not in parts or (sh,ref) in seen:raise ValueError('工作表不存在或地址重复')
                seen.add((sh,ref))
                info=next(s for s in snapshot_info['sheets'] if s['name']==sh)
                if info['protected'] or info['hidden']:raise ValueError('不能修改受保护或隐藏的工作表')
                if r>info['rows'] or c>info['cols']:raise ValueError('请在已有表格范围内编辑')
                if any(inside(ref,a) and ref!=a.split(':')[0] for a in info['merges']):raise ValueError('请编辑合并区域左上角')
                kind=change.get('type','text');value=change.get('value')
                if info['cells'].get(ref,{}).get('type')=='date':
                    # Date entry remains typed as Excel date; existing number format is retained.
                    if kind!='date' or not isinstance(value,str):raise ValueError('日期请输入YYYY-MM-DD')
                    try:date=dt.date.fromisoformat(value)
                    except ValueError:raise ValueError('日期请输入YYYY-MM-DD')
                    props=ET.fromstring(z.read('xl/workbook.xml')).find('m:workbookPr',NS)
                    epoch=dt.date(1904,1,1) if props is not None and props.get('date1904') in ('1','true') else dt.date(1899,12,30)
                    value=(date-epoch).days;kind='number'
                grouped.setdefault(parts[sh],[]).append((ref,value,kind))
            modified={}
            for part,edits in grouped.items():
                xml=z.read(part).decode('utf-8');root=ET.fromstring(xml)
                for ref,value,kind in edits:xml=_patch_cell(xml,root,ref,value,kind)
                ET.fromstring(xml);modified[part]=xml.encode('utf-8')
            book=z.read('xl/workbook.xml').decode('utf-8')
            calc=re.search(r'<((?:\w+:)?)calcPr\b[^>]*/>',book)
            if calc:
                el=calc.group(0)
                for key,val in [('fullCalcOnLoad','1'),('forceFullCalc','1'),('calcMode','auto')]:
                    el=re.sub(r'\s'+key+r'=["\'][^"\']*["\']','',el)
                    el=el[:-2]+f' {key}="{val}"/>'
                book=book[:calc.start()]+el+book[calc.end():]
            else:
                pre=re.search(r'<((?:\w+:)?)workbook\b',book)[1]
                book=book.replace(f'</{pre}workbook>',f'<{pre}calcPr fullCalcOnLoad="1" forceFullCalc="1" calcMode="auto"/></{pre}workbook>')
            modified['xl/workbook.xml']=book.encode('utf-8')
            output=io.BytesIO()
            with zipfile.ZipFile(output,'w') as target:
                target.comment=z.comment
                for i in z.infolist():target.writestr(i,modified.get(i.filename,z.read(i.filename)))
        # Reject outside edits again immediately before replacing the original.
        if hashlib.sha256(path.read_bytes()).hexdigest()!=current:raise ValueError('changed')
        backups=path.parent/'.pga-sheet-backups';backups.mkdir(exist_ok=True)
        backup=backups/(path.stem+'-'+current[:16]+'.xlsx')
        if not backup.exists():backup.write_bytes(raw)
        fd,name=tempfile.mkstemp(prefix='.'+path.name+'.',suffix='.pga-save',dir=path.parent)
        try:
            os.fchmod(fd,stat.S_IMODE(path.stat().st_mode))
            with os.fdopen(fd,'wb') as f:f.write(output.getvalue());f.flush();os.fsync(f.fileno())
            if hashlib.sha256(path.read_bytes()).hexdigest()!=current:raise ValueError('changed')
            os.replace(name,path)
        finally:
            if os.path.exists(name):os.unlink(name)
        return {'saved':True,'version':hashlib.sha256(output.getvalue()).hexdigest(),'mtime':str(path.stat().st_mtime_ns),'size':path.stat().st_size,'backup':str(backup)}
