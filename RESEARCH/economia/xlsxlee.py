# Lector minimo de xlsx con solo stdlib: zipfile + ElementTree.
import zipfile, re, sys
import xml.etree.ElementTree as ET
NS='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
NSR='{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'

def col2idx(ref):
    m=re.match(r'([A-Z]+)', ref); n=0
    for ch in m.group(1): n=n*26+(ord(ch)-64)
    return n-1

def hojas(path):
    z=zipfile.ZipFile(path)
    wb=ET.fromstring(z.read('xl/workbook.xml'))
    rels={r.get('Id'):r.get('Target') for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
    out=[]
    for sh in wb.iter(NS+'sheet'):
        t=rels[sh.get(NSR+'id')].lstrip('/')
        if not t.startswith('xl/'): t='xl/'+t
        out.append((sh.get('name'), t))
    return out

def leer(path, target):
    z=zipfile.ZipFile(path)
    sst=[]
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).iter(NS+'si'):
            sst.append(''.join(t.text or '' for t in si.iter(NS+'t')))
    filas=[]
    for _,row in ET.iterparse(z.open(target), events=('end',)):
        if row.tag!=NS+'row': continue
        cel={}
        for c in row.iter(NS+'c'):
            v=c.find(NS+'v'); ty=c.get('t')
            if ty=='inlineStr':
                val=''.join(t.text or '' for t in c.iter(NS+'t'))
            elif v is None: continue
            elif ty=='s': val=sst[int(v.text)]
            else: val=v.text
            if val is not None and str(val).strip()!='': cel[col2idx(c.get('r'))]=str(val).strip()
        if cel:
            ancho=max(cel)+1
            filas.append([cel.get(i,'') for i in range(ancho)])
        row.clear()
    return filas

if __name__=='__main__':
    p=sys.argv[1]
    if len(sys.argv)==2:
        for n,t in hojas(p): print(n,'->',t)
    else:
        idx=int(sys.argv[2]); lim=int(sys.argv[3]) if len(sys.argv)>3 else 30
        n,t=hojas(p)[idx]; print('### HOJA:',n)
        for i,f in enumerate(leer(p,t)[:lim]): print(i,'|','|'.join(f))
