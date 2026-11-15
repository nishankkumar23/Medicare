const t=location.pathname.split('/').pop();
fetch('/api/verify/'+encodeURIComponent(t)).then(async r=>{const d=await r.json();const o=document.getElementById('out');
 if(!r.ok||!d.authentic){o.innerHTML='<h2 style="color:#b91c1c">✖ Invalid</h2><p>This code does not match any prescription.</p>';return}
 const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
 o.innerHTML=`<h2 style="color:${d.status==='active'?'#047857':'#b91c1c'}">${d.status==='active'?'✔ Authentic':'⚠ Authentic record, NOT valid for dispensing'}</h2>
 <table><tr><th>Prescription ID</th><td>${esc(d.rxCode)}</td></tr><tr><th>Issued by</th><td>${esc(d.issuedBy)}</td></tr>
 <tr><th>Issued</th><td>${esc(d.issuedAt)}</td></tr><tr><th>Status</th><td><span class="badge ${esc(d.status)}">${esc(d.status)}</span></td></tr>
 <tr><th>Revoked / superseded</th><td>${d.revoked?'Revoked':d.superseded?'Superseded':'No'}</td></tr></table>`;
}).catch(()=>{document.getElementById('out').textContent='Network error. Try again.'});
