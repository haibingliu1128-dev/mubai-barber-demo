/* 木白理发工作室 · 行业前端模块：发型师（总监/设计师两级价）、按发型师现场取号（前面人数/预计等待）、指定发型师预约、作品集、会员卡（银卡 8.5 折 / 金卡 8 折）、师傅工作台 */
window.IND=function(Q){
var X=Q.X,S=Q.S,V=Q.V,I=Q.I,esc=Q.esc,api=Q.api;
var SCI='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/></svg>';
var SCIF=SCI.replace('stroke-width="1.8"','stroke-width="2.6"');
var TICK='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16v3a2 2 0 000 4v3H4v-3a2 2 0 000-4z"/><path d="M14 7v10" stroke-dasharray="2 2"/></svg>';
var CARD='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h4"/></svg>';
var HC=['#2B2321','#5A3A26','#8C5A3C','#C68B59','#3B3B4A','#7A2E3A'];
function hairArt(i){var c=HC[i%6],sk='#F2D2BC';var hair=[
 'M30 38c0-14 9-22 20-22s20 8 20 22c-3-6-8-9-20-9s-17 3-20 9z',
 'M28 52c-2-22 6-34 22-34s24 12 22 34c-2-8-4-14-6-18-8 4-24 4-32 0-2 4-4 10-6 18z',
 'M26 80c-6-30 0-60 24-60s30 30 24 60c-4-2-6-6-6-12 0-14 2-24-2-30-6 2-24 2-32 0-4 6-2 16-2 30 0 6-2 10-6 12z',
 'M28 44c-6-6-2-18 4-20 2-8 12-10 18-6 6-4 16-2 18 6 6 2 10 14 4 20-2-6-6-8-8-8-6 2-22 2-28 0-2 0-6 2-8 8z',
 'M31 40c0-14 6-22 19-22 14 0 20 6 20 14l-4 2c-6-4-16-4-24-2-6 2-9 5-11 8z',
 'M30 40c0-14 9-22 20-22s20 8 20 22c-4-6-10-8-20-8s-16 2-20 8zM68 34c8 4 10 14 6 24-2-6-4-10-8-12z'][i%6];
 var bg=['#EDE7DD','#E6E9EE','#F2E6E6','#E7EDE5','#EEE8F3','#F3EDE0'][i%6];
 return '<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="'+bg+'"/><path d="M22 100c2-16 14-22 28-22s26 6 28 22z" fill="#3A3A3C"/><rect x="44" y="62" width="12" height="14" fill="'+sk+'"/><ellipse cx="50" cy="46" rx="17" ry="20" fill="'+sk+'"/>'+(i%6===3?'<g fill="'+c+'">'+[28,36,44,52,60,68].map(function(x){return '<circle cx="'+x+'" cy="'+(x%16?26:22)+'" r="7"/>'}).join('')+'</g>':'')+'<path d="'+hair+'" fill="'+c+'"/><circle cx="43" cy="47" r="1.6" fill="#2B2321"/><circle cx="57" cy="47" r="1.6" fill="#2B2321"/><path d="M46 56c2.5 1.6 5.5 1.6 8 0" stroke="#B5705A" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>'}
var WORKN=['清爽短发','法式慵懒中长发','长发层次','羊毛卷烫','渐变油头','高颅顶染发'];
function sav(t,cls){return '<div class="sav'+(cls?' '+cls:'')+'">'+hairArt(t.avatar||0)+'</div>'}
function tierTag(t){return '<span class="tier '+esc(t.tier||'')+'">'+esc(t.tierName||t.title||'')+'</span>'}
function P(){return Q.C.industry||{}}
function LONG(){return P().longMin||100}
function isLong(s){return s&&s.duration>=LONG()}
function stys(){return (P().resources||[]).filter(function(r){return r.kind==='stylist'&&r.active})}
function styById(id){return stys().filter(function(t){return t.id===+id})[0]}
function tprice(s,t){return s.pricing&&t&&s.pricing[t.tier]!=null?s.pricing[t.tier]:s.price}
function next7(){var o=[],d=Q.parseYmd(Q.today());for(var i=0;i<7;i++)o.push(Q.ymd(Q.addDays(d,i)));return o}
function dayShort(ds,i){return i===0?'今':i===1?'明':i===2?'后':Q.WEEK[Q.parseYmd(ds).getDay()]}
function wkHtml(t){return '<div class="wk">'+next7().map(function(ds,i){var off=t.offDays.indexOf(Q.parseYmd(ds).getDay())>=0;return '<span class="'+(off?'off':'')+'">'+dayShort(ds,i)+'<small>'+(off?'休':t.start.slice(0,2)+'-'+t.end.slice(0,2))+'</small></span>'}).join('')+'</div>'}
function stars(t){return t.rating&&t.rating.n?'<span class="stars">★ '+t.rating.avg.toFixed(1)+'</span><span class="mini">'+t.rating.n+' 条评价</span>':'<span class="mini">暂无评价</span>'}
var QB=null,MQ=null,MYC=null,REV={},LED=null,MC=null;
function loadQB(){return api('GET','/api/queue',null,'c').then(function(r){QB=r;return r},function(){})}
function qOf(B,id){if(!B||!B.summary)return null;return B.summary.stylists.filter(function(x){return x.id===+id})[0]||null}
function grp(B,id){if(!B)return null;return B.groups.filter(function(g){return g.key===String(id)})[0]||null}
function etaText(m){return m<=0?'无需等待':'约 '+m+' 分钟'}
function qState(q){return !q?'':q.off?'今日休息':!q.inShift?'不在班（'+q.start+'-'+q.end+'）':'前面 <b>'+q.ahead+'</b> 人 · '+etaText(q.eta)}
function canQ(q){return q&&!q.off&&q.inShift}
function bestCard(){if(!MYC)return null;return MYC.cards.filter(function(k){return k.kind==='balance'})[0]||null}
function loadMyCards(){if(!Q.ME.token)return Promise.resolve(null);return api('GET','/api/me/cards',null,'c').then(function(r){MYC=r;return r},function(){})}
function prods(){return (P().cardProducts||[]).filter(function(p){return p.kind==='balance'})}
function discTxt(d){return (d/100).toFixed(d%100?1:0).replace(/\.0$/,'')+' 折'}
function myLive(){return (Q.ME.bookings||[]).filter(function(b){return b.date===Q.today()&&b.status==='arrived'})}

Object.assign(X,{
  brand:'木白理发工作室',brandSub:'MUBAI BARBER · 剪 · 烫 · 染',heroTags:['按发型师取号','总监 / 设计师','会员卡最低 8 折'],avatar:'木',member:'木白会员',ownerPwd:'mubai2026',resLabel:'发型师',
  tabs:[['home','首页',I.home,I.homeF],['stylists','发型师',SCI,SCIF],['book','预约',I.cal,I.calF],['mine','我的',I.user,I.userF]],
  flow:['book','sty','time','info','confirm'],stepNames:['选服务','选发型师','时间/排队','填信息','确认'],
  bookTitle:'选择服务',svcTitle:'服务项目',hotTitle:'服务价目',notePh:'选填：如 两边推短、保留长度',svcPh:'造型',staffPh:'前台小木',timeWord:'到店时间',
  durations:[30,45,60,90,120,150,180],openSub:'总监 / 设计师 · 现场取号或预约',
  notice:'请按预约时间到店，迟到超过 15 分钟可能需要重新排队；会员卡支付的预约取消后自动退回余额；',
  heroArt:function(){return '<div class="pole"></div>'},
  quick:[['qWalk','',TICK,'现场取号','#FBF1DC','#B9821A'],['startBook','',I.cal,'预约免排队','#EDEDED','#1C1C1E'],['tab','stylists',SCI,'发型师','#F2E6E6','#C0392B'],['toMerchant','',I.shop,'师傅工作台','#E6EEF4','#2457A5']],
  svcMeta:function(s){var p=s.pricing||{};return '设计师 ¥'+(p.designer!=null?p.designer:s.price)+' / 总监 ¥'+(p.director!=null?p.director:s.price)},
  estimate:function(s){var t=S.sel.resourceId&&styById(S.sel.resourceId);return t?{price:tprice(s,t),duration:s.duration}:null},
  keepRes:function(){return true},
  svcFilter:function(s){return !(S.sel.walk&&isLong(s))},
  bookTop:function(){var t=S.sel.resourceId&&styById(S.sel.resourceId);
    return (S.sel.walk?'<div class="notice" style="margin-top:0">现场取号 · 烫发、染发等长时项目请<a data-a="toBook" style="color:var(--gold-d)">预约</a></div>':'')+(t?'<div class="tierbar">'+sav(t,'xs')+'<span>'+esc(t.name)+' '+tierTag(t)+' 的价目</span></div>':'')},
  timeTop:function(){var t=S.sel.resourceId&&styById(S.sel.resourceId);if(!t)return '';
    return '<div class="card row2" style="padding:10px 12px">'+sav(t,'sm')+'<div style="flex:1"><b>'+esc(t.name)+'</b>'+tierTag(t)+'<div class="mini">班次 '+t.start+'-'+t.end+' · 只显示 TA 有空的时段</div></div></div>'},
  walkView:function(s){var t=styById(S.sel.resourceId),q=qOf(QB,S.sel.resourceId),g=grp(QB,S.sel.resourceId);if(!t)return V.sty();
    return {nav:Q.nav('现场取号',{back:true}),body:Q.steps('time')+'<div class="pad"><div class="card row2" style="padding:12px">'+sav(t,'sm')+'<div style="flex:1"><b>'+esc(t.name)+'</b>'+tierTag(t)+'<div class="mini">'+esc(s.name)+' · '+s.duration+' 分钟 · <b class="price">'+tprice(s,t)+'</b></div></div></div>'+
      (QB&&q?'<div class="qticket"><div class="mini" style="color:#bbb">前面等待</div><div class="no">'+q.ahead+'<small style="font-size:16px"> 人</small></div><div style="font-size:13px;opacity:.85">现在取号 · 预计等待 '+etaText(q.eta)+'</div></div>'+
      '<div class="card wb" style="margin-top:12px">'+(q.serving?'<div class="cur">正在服务 '+esc(q.serving.queueNo||'')+' · '+esc(q.serving.serviceName)+' · 已 '+q.serving.mins+' 分钟<div class="bar"><i style="width:'+q.serving.pct+'%"></i></div></div>':'<div class="cur idle">空闲中，到店即可开始</div>')+
      (g&&g.waiting.length?'<div class="qchips">'+g.waiting.map(function(w){return '<span>'+esc(w.queueNo||'')+' '+esc(w.label||'')+'</span>'}).join('')+'</div>':'')+'<div class="mini" style="margin-top:8px">按当前服务剩余时间与前面顾客的项目时长估算，仅供参考</div></div>'+
      (canQ(q)?'':'<div class="notice">'+esc(t.name)+qState(q).replace(/<[^>]+>/g,'')+'，暂不能取号，可换一位或预约其他时间。</div>'):Q.loading())+'</div>',
      foot:'<div class="foot"><div class="sum">'+(q?'前面 '+q.ahead+' 人':'')+'</div><button class="btn" data-a="flowNext"'+(canQ(q)?'':' disabled')+'>下一步</button></div>'}},
  walkWhen:function(){var q=qOf(QB,S.sel.resourceId);return q?'前面 '+q.ahead+' 人 · '+etaText(q.eta):''},
  beforeNext:function(view){if(view==='sty'&&!S.sel.resourceId){Q.toast('请选择发型师');return false}},
  confirmRows:function(){var t=S.sel.resourceId&&styById(S.sel.resourceId);return (t?'<div class="kv"><span>发型师</span><span>'+esc(t.name)+' · '+esc(t.tierName||'')+'</span></div>':'')+(S.sel.walk?'<div class="kv"><span>排队</span><span>'+esc(X.walkWhen())+'</span></div>':'')},
  successText:function(b){if(b.kind==='walk')return '你的号码 <b>'+esc(b.queueNo||'')+'</b>，请留意叫号；可在首页查看前面还有几人';return (b.resourceName?esc(b.resourceName)+' 已为你留好时间，到店免排队':'已预约')+(b.payMethod==='balance'?'；已按会员折扣从卡内扣款（取消自动退回）':'')},
  homeTop:function(){var L=stys();
    return '<div class="card qcard"><div class="row2" style="margin-bottom:4px"><b style="font-size:15px">现场排队</b><span class="livedot"><i></i>实时</span><span style="flex:1"></span><span class="mini">按发型师分别排队</span></div>'+
      L.map(function(t){var q=qOf(QB,t.id);return '<div class="qrow">'+sav(t)+'<div style="flex:1;min-width:0"><b>'+esc(t.name)+'</b>'+tierTag(t)+'<div class="qn">'+(QB?qState(q):'…')+'</div></div><button class="btn sm'+(canQ(q)?' goldb':' gray')+'" data-a="qTake" data-v="'+t.id+'"'+(canQ(q)?'':' disabled')+'>'+(q&&q.off?'休息':'取号')+'</button></div>'}).join('')+'</div>'},
  homeLive:function(){var L=myLive();if(!L.length)return '';return L.map(function(b){var q=qOf(QB,b.resourceId),g=grp(QB,b.resourceId),pos=-1;if(g)g.waiting.forEach(function(w,i){if(w.id===b.id)pos=i});
    return '<div class="qticket mine"><div class="mini" style="color:#bbb">'+esc(b.resourceName||'')+' · '+esc(b.serviceName)+'</div><div class="no">'+esc(b.queueNo||b.time)+'</div><div style="font-size:13px">'+(b.progress==='serving'?'正在为你服务':pos>=0?'前面还有 '+pos+' 人 · 预计 '+etaText(g.waiting[pos].eta||0):'已签到，请稍候')+'</div></div>'}).join('')},
  homeMid:function(){var L=prods();return '<div class="vipc"><div class="lv">木白会员卡</div><div style="margin-top:6px;font-size:13px">'+L.map(function(p){return esc(p.name)+' 充 '+p.price+' 享 '+discTxt(p.discount)}).join(' · ')+'</div><div class="mini" style="color:#bbb;margin-top:6px">到店办理 · 余额支付按折扣扣款（示例）</div></div>'},
  homeExtra:function(){var L=stys(),W=[];L.forEach(function(t){(t.extra.works||[]).slice(0,2).forEach(function(w){W.push([w,t])})});
    return '<div class="sec-t">作品集<small data-a="tab" data-v="stylists" style="cursor:pointer">发型师 ›</small></div><div class="works">'+W.slice(0,6).map(function(x){return '<div data-a="styDetail" data-v="'+x[1].id+'">'+hairArt(x[0])+'<span>'+esc(WORKN[x[0]%6])+' · '+esc(x[1].name)+'</span></div>'}).join('')+'</div><div class="mini" style="margin:6px 2px 0">作品图为示意插画</div>'},
  mineExtra:function(){if(!Q.ME.token)return '';var k=bestCard();
    return '<div class="pad" style="padding-bottom:0"><div class="vipc"><div class="lv">'+(k?esc(k.level||k.name)+' · '+discTxt(k.discount):'未办卡')+'</div><div class="bal"><small>¥</small>'+(k?k.balance:0)+'</div><div class="row2" style="margin-top:6px"><span class="mini" style="color:#bbb;flex:1">'+(k?'预约时选「会员卡」自动按折扣扣款':'到店可办银卡 / 金卡')+'</span>'+(k?'<button class="btn sm ghostv" data-a="goLedger">明细</button>':'')+'</div></div></div>'},
  mTiles:function(){return '<button data-a="mIssue"><span class="qi" style="background:#FBF1DC;color:#B9821A">'+CARD+'</span><div><b>办会员卡</b><span>银卡 / 金卡 · 线下收款</span></div></button>'},
  mTop:function(){var L=stys();return '<div class="sec-t">师傅工作台<small>叫号 → 完成</small></div>'+(!MQ?Q.loading():L.map(function(t){var q=qOf(MQ,t.id)||{},g=grp(MQ,t.id)||{serving:[],waiting:[]},sv=g.serving[0],w0=g.waiting[0],h=Q.can('booking.handle');
    return '<div class="wb"><div class="row2">'+sav(t,'sm')+'<div style="flex:1"><b>'+esc(t.name)+'</b>'+tierTag(t)+'<div class="mini">'+(q.off?'今日休息':'等待 '+g.waiting.length+' 人 · 新取号预计 '+etaText(q.eta||0))+'</div></div>'+
      (h&&w0&&!sv?'<button class="btn sm goldb" data-a="mOp" data-v="next|'+w0.id+'">叫号 '+esc(w0.queueNo||w0.time)+'</button>':'')+'</div>'+
      (sv?'<div class="cur"><div class="row2"><span style="flex:1">服务中 <b>'+esc(sv.queueNo||sv.time)+'</b> '+esc(sv.name||'')+' · '+esc(sv.serviceName)+'</span>'+(h?'<button class="btn sm" data-a="mOp" data-v="next|'+sv.id+'">完成</button>':'')+'</div><div class="bar"><i style="width:'+((q.serving&&q.serving.pct)||5)+'%"></i></div></div>':(q.off?'':'<div class="cur idle">空闲</div>'))+
      (g.waiting.length?'<div class="qchips">'+g.waiting.map(function(x){return '<span>'+esc(x.queueNo||x.time)+' '+esc(x.name||'')+'</span>'}).join('')+'</div>':'')+'</div>'}).join(''))},
  mHomeLoad:function(){return api('GET','/api/merchant/queue',null,'m').then(function(r){MQ=r},function(){MQ=null})},
  mTabs:[['today','今日预约'],['upcoming','后续预约'],['cards','会员卡'],['all','全部记录']],
  mTabLoad:{cards:function(){return Promise.all([api('GET','/api/merchant/cards',null,'m'),api('GET','/api/merchant/ledger?kinds=open,recharge,pay,refund',null,'m')]).then(function(r){MC=r[0];LED=r[1];return []})}},
  mList:{cards:function(){if(!MC)return Q.loading();var K=MC.cards.filter(function(k){return k.kind==='balance'});
    return (K.length?K.map(function(k){return '<div class="card mrow"><div><b>'+esc(k.cname||'顾客')+'</b> <span class="muted">'+esc(k.phone||'')+'</span>'+(k.seed?'<span class="demo-tag">示例</span>':'')+'<div class="mini">'+esc(k.level||k.name)+' · '+discTxt(k.discount)+'</div></div><b class="price">'+k.balance+'</b></div>'}).join(''):Q.emptyBox('还没有会员',false))+
      '<div class="sec-t">会员卡流水</div><div class="card" style="padding:4px 14px">'+(LED&&LED.length?LED.slice(0,20).map(function(l){return '<div class="cell"><span class="t">'+esc(LKN[l.kind]||l.kind)+' · '+esc(l.cname||'顾客')+'<br><small class="muted">'+esc(l.note||'')+' · '+esc(new Date(l.at).toLocaleString('zh-CN',{hour12:false}))+'</small></span><b class="'+(l.amount>=0?'plus':'minus')+'">'+(l.amount>=0?'+':'')+l.amount+'</b></div>'}).join(''):'<div class="mini" style="padding:12px 0">暂无记录</div>')+'</div>'}},
  liveViews:['stylists','sdetail','ledger','sty'],
  onPublic:function(){if(['home','sty','time','confirm'].indexOf(S.view)>=0)return loadQB()},
  onBookErr:function(e){if(['RESOURCE_NOT_FOUND','NEED_RESOURCE','RESOURCE_OFF','RESOURCE_SHIFT'].indexOf(e.code)>=0){Q.alertBox('请重新选择发型师',e.message);S.stack=[];S.view='sty';Q.render(true);return true}}
});
var LKN={open:'办卡',recharge:'充值',pay:'会员卡支付',refund:'取消退回',use:'核销',manual:'调整'};
X.enter.home=function(){loadQB().then(function(){if(S.view==='home')Q.render(false)});if(Q.ME.token)Q.loadMine().then(function(){if(S.view==='home')Q.render(false)},function(){})};
X.enter.sty=function(){loadQB().then(function(){if(S.view==='sty')Q.render(false)})};
X.enter.time=function(){if(S.sel.walk)loadQB().then(function(){if(S.view==='time')Q.render(false)})};
X.enter.mine=X.enter.ledger=function(){loadMyCards().then(function(){if(['mine','ledger'].indexOf(S.view)>=0)Q.render(false)})};
X.enter.sdetail=function(){var id=S.tid;loadQB().then(function(){if(S.view==='sdetail')Q.render(false)});api('GET','/api/reviews?resourceId='+id+'&limit=10').then(function(r){REV[id]=r;if(S.view==='sdetail')Q.render(false)},function(){})};

/* ---------- 顾客：选发型师 / 发型师列表 / 详情 ---------- */
function styCard(t,mode,on,s){var q=qOf(QB,t.id),pr=s?tprice(s,t):null,blocked=mode==='pick'&&S.sel.walk&&!canQ(q);
  return '<button class="sty'+(on?' on':'')+(blocked?' off':'')+'" data-a="'+(mode==='pick'?'styPick':'styDetail')+'" data-v="'+t.id+'"'+(blocked?' disabled':'')+'>'+sav(t)+'<div style="flex:1;min-width:0"><div class="row2"><b>'+esc(t.name)+'</b>'+tierTag(t)+'<span style="flex:1"></span>'+(pr!=null?'<b class="price">'+pr+'</b>':stars(t))+'</div>'+
    '<div class="tagsx">'+t.tags.map(function(x){return '<span>'+esc(x)+'</span>'}).join('')+'</div><div class="mini" style="margin-top:4px">'+(S.sel.walk&&mode==='pick'?(QB?qState(q):'…'):esc(t.intro||''))+'</div>'+
    (mode==='pick'?'':'<div class="works mini">'+(t.extra.works||[]).map(function(w){return '<div>'+hairArt(w)+'</div>'}).join('')+'</div>')+'</div>'+(mode==='pick'?'<span class="pick">'+(on?I.check:'')+'</span>':'')+'</button>'}
V.sty=function(){var s=Q.svcById(S.sel.serviceId);if(!s)return V.book();var t=S.sel.resourceId&&styById(S.sel.resourceId);
  return {nav:Q.nav(S.sel.walk?'选择排队的发型师':'选择发型师',{back:true}),body:Q.steps('sty')+'<div class="pad"><div class="mini" style="margin:0 2px 10px">「'+esc(s.name)+'」总监价与设计师价不同'+(S.sel.walk?' · 每位发型师单独排队':'')+'</div>'+stys().map(function(x){return styCard(x,'pick',S.sel.resourceId===x.id,s)}).join('')+'</div>',
    foot:'<div class="foot"><div class="sum">'+(t?esc(t.name)+' <b class="price">'+tprice(s,t)+'</b>':'请选择发型师')+'</div><button class="btn" data-a="flowNext"'+(t?'':' disabled')+'>下一步</button></div>'}};
V.stylists=function(){return {nav:Q.nav('发型师'),tab:true,body:'<div class="pad"><div class="mini" style="margin:0 2px 10px">总监 / 设计师两级定价；可指定发型师预约，或到店按发型师取号（示例发型师）</div>'+stys().map(function(t){return styCard(t)}).join('')+'</div>'}};
V.sdetail=function(){var t=styById(S.tid);if(!t)return V.stylists();var r=REV[t.id],q=qOf(QB,t.id),k=bestCard();
  return {nav:Q.nav(esc(t.name),{back:true}),body:'<div class="pad"><div class="card" style="text-align:center;padding:20px 14px">'+sav(t,'lg')+'<b class="tn">'+esc(t.name)+'</b>'+tierTag(t)+'<div style="margin-top:4px">'+stars(t)+'</div><div class="tagsx" style="justify-content:center">'+t.tags.map(function(x){return '<span>'+esc(x)+'</span>'}).join('')+'</div><div class="mini" style="margin-top:8px">'+esc(t.intro||'')+'</div>'+
    '<div class="qn" style="margin-top:10px">'+(QB?qState(q):'')+'</div></div>'+
    '<div class="card"><div class="sec-t" style="margin:0 0 8px">作品<small>示意插画</small></div><div class="works">'+(t.extra.works||[]).map(function(w){return '<div>'+hairArt(w)+'<span>'+esc(WORKN[w%6])+'</span></div>'}).join('')+'</div></div>'+
    '<div class="card"><div class="sec-t" style="margin:0 0 4px">价目<small>'+esc(t.tierName||'')+'价'+(k?' · 你的'+esc(k.level||'')+' '+discTxt(k.discount):'')+'</small></div>'+Q.C.services.map(function(s){var p=tprice(s,t);return '<div class="kv"><span>'+esc(s.name)+' · '+s.duration+'分钟'+(isLong(s)?' <small class="muted">仅预约</small>':'')+'</span><span><b class="price">'+p+'</b>'+(k?'<span class="mp">卡 ¥'+Math.round(p*k.discount/10)/100+'</span>':'')+'</span></div>'}).join('')+'</div>'+
    '<div class="card"><div class="sec-t" style="margin:0 0 4px">近 7 天排班<small>'+t.start+'-'+t.end+'</small></div>'+wkHtml(t)+'</div>'+
    '<div class="card"><div class="sec-t" style="margin:0 0 4px">顾客评价<small>'+(r?r.summary.count+' 条':'')+'</small></div>'+(!r?Q.loading():r.items.length?r.items.map(function(x){return Q.reviewItem(x,true)}).join(''):'<div class="mini" style="padding:8px 0">暂无评价</div>')+'</div></div>',
    foot:'<div class="foot" style="gap:10px"><button class="btn ghost" style="flex:1" data-a="qTake" data-v="'+t.id+'"'+(canQ(q)?'':' disabled')+'>现场取号</button><button class="btn" style="flex:1" data-a="bookSty" data-v="'+t.id+'">预约 '+esc(t.name)+'</button></div>'}};
X.act.styDetail=function(v){S.tid=+v;Q.go('sdetail')};
X.act.styPick=function(v){S.sel.resourceId=+v;S.sel.time=null;S.quote=null;Q.AV=null;Q.render(false)};
X.act.bookSty=function(v){var keep=S.sel;S.sel=Q.newSel(keep);S.sel.resourceId=+v;S.stack=[];S.tab='book';Q.go('book')};
X.act.qWalk=function(){var keep=S.sel;S.sel=Q.newSel(keep);S.sel.walk=true;S.stack=[];S.tab='book';Q.go('book')};
X.act.qTake=function(v){var keep=S.sel;S.sel=Q.newSel(keep);S.sel.walk=true;S.sel.resourceId=+v;S.stack=[];S.tab='book';Q.go('book')};
X.act.toBook=function(){S.sel.walk=false;Q.render(false)};
V.ledger=function(){var L=MYC?MYC.ledger:null;
  return {nav:Q.nav('会员卡明细',{back:true}),body:'<div class="pad"><div class="card" style="padding:4px 14px">'+(!L?Q.loading():L.length?L.map(function(l){return '<div class="cell"><span class="t">'+esc(LKN[l.kind]||l.kind)+(l.note?' <small class="muted">'+esc(l.note)+'</small>':'')+(l.seed?'<span class="demo-tag">示例</span>':'')+'<br><small class="muted">'+esc(new Date(l.at).toLocaleString('zh-CN',{hour12:false}))+'</small></span><b class="'+(l.amount>=0?'plus':'minus')+'">'+(l.amount>=0?'+':'')+l.amount+'</b></div>'}).join(''):'<div class="mini" style="padding:12px 0">暂无记录</div>')+'</div></div>'}};
X.act.goLedger=function(){Q.go('ledger')};

/* ---------- 商家：办会员卡 ---------- */
X.act.mIssue=function(){var L=prods();
  Q.sheet('办会员卡','<div class="card" style="padding:2px 14px"><div class="field"><label>顾客称呼</label><input id="mc-name" maxlength="12" placeholder="如：王先生"></div><div class="field"><label>手机号</label><input id="mc-phone" type="tel" inputmode="numeric" maxlength="11" placeholder="11 位手机号"></div></div>'+
  '<div class="card"><div class="mini" style="margin-bottom:8px">卡种</div><div class="chipsel" id="mc-prods">'+L.map(function(p,i){return '<button class="'+(i===0?'on':'')+'" data-a="mcPick" data-v="'+p.id+'">'+esc(p.name)+' ¥'+p.price+' · '+discTxt(p.discount)+'</button>'}).join('')+'</div><div class="mini" style="margin-top:8px">演示：线下收款后登记，不产生真实支付；已有卡的会员余额累加，折扣取更优。</div></div>'+
  '<div style="display:flex;gap:10px"><button class="btn gray" style="flex:1" data-a="closeSheet">取消</button><button class="btn" style="flex:1" data-a="mcSave">确认办卡</button></div>')};
X.act.mcPick=function(v,t){[].slice.call(document.querySelectorAll('#mc-prods button')).forEach(function(b){b.classList.remove('on')});t.classList.add('on')};
X.act.mcSave=function(){var on=document.querySelector('#mc-prods button.on'),b={name:document.getElementById('mc-name').value.trim(),phone:document.getElementById('mc-phone').value.trim(),productId:on?+on.getAttribute('data-v'):null};
  if(!/^1\d{10}$/.test(b.phone)){Q.toast('请输入正确的 11 位手机号');return}
  api('POST','/api/merchant/cards',b,'m').then(function(k){Q.closeSheet();Q.toast('已办卡：'+(k.level||k.name)+'，余额 ¥'+k.balance);Q.mLoad('merchant')},Q.fail)};
};
