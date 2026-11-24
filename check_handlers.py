import re,sys
s=open(sys.argv[1] if len(sys.argv)>1 else 'admin.html').read()
skip={'if','scrollTo','confirm','alert','prompt','setTimeout','event','stopPropagation','open','this','return','function','esc','encodeURIComponent','Number','String','JSON','parseInt','parseFloat','Math','Date','Array','Object','$'}
miss=set()
for h in re.findall(r'\bon(?:click|change|input|keyup|submit)=\\?"(.*?)\\?"',s,re.S):
    h=re.sub(r"\$\{.*?\}","",h)
    for n in re.findall(r'(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(',h):
        if n in skip: continue
        if not re.search(r'(function\s+(async\s+)?%s\b|(let|const|var)\s+%s\b|[,;{\s]%s\s*=[^=])'%(re.escape(n),re.escape(n),re.escape(n)),s): miss.add(n)
print("MISSING:",sorted(miss)); sys.exit(1 if miss else 0)
