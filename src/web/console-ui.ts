const BRAND_ICON_DATA_URI = "data:image/png;base64,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";
export const OPERATIONS_CONSOLE_HTML = String.raw`<!doctype html>
<html lang="en" data-theme="system">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Bridge Task Console</title>
<style>
:root{--ink:#17231f;--ink-soft:#33443d;--paper:#f1ede2;--panel:#fffdf7;--panel-2:#e9e3d5;--line:#c9c0ad;--accent:#d95a2b;--accent-2:#0b7263;--ok:#1e7650;--warn:#a56613;--bad:#a9322b;--muted:#68746e;--code:#16201c;--code-ink:#f3f0df;--shadow:6px 6px 0 rgba(23,35,31,.12);--display:"Bahnschrift SemiCondensed","Aptos Display","Trebuchet MS",sans-serif;--body:"Aptos","Segoe UI Variable","Trebuchet MS",sans-serif;--serif:"Sitka Display",Georgia,serif;--mono:"Cascadia Code","Consolas",monospace}
:root[data-theme="dark"]{--ink:#e9eddf;--ink-soft:#c5cdc2;--paper:#101714;--panel:#18221e;--panel-2:#202d28;--line:#3a4a43;--accent:#ff7a4c;--accent-2:#56c1ae;--ok:#65c795;--warn:#e1a35b;--bad:#ff8178;--muted:#9caaa2;--code:#090e0c;--code-ink:#e9eddf;--shadow:6px 6px 0 rgba(0,0,0,.3)}
@media(prefers-color-scheme:dark){:root[data-theme="system"]{--ink:#e9eddf;--ink-soft:#c5cdc2;--paper:#101714;--panel:#18221e;--panel-2:#202d28;--line:#3a4a43;--accent:#ff7a4c;--accent-2:#56c1ae;--ok:#65c795;--warn:#e1a35b;--bad:#ff8178;--muted:#9caaa2;--code:#090e0c;--code-ink:#e9eddf;--shadow:6px 6px 0 rgba(0,0,0,.3)}}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 95% 0,color-mix(in srgb,var(--accent) 18%,transparent),transparent 28rem),linear-gradient(135deg,var(--paper),color-mix(in srgb,var(--paper) 78%,var(--panel-2)));color:var(--ink);font-family:var(--body);min-height:100vh}body:before{content:"";position:fixed;inset:0;pointer-events:none;z-index:-1;opacity:.3;background-image:linear-gradient(color-mix(in srgb,var(--ink) 7%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--ink) 7%,transparent) 1px,transparent 1px);background-size:36px 36px}
.mono,code,pre{font-family:var(--mono)}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.shell{max-width:1540px;margin:0 auto;padding:20px clamp(14px,3vw,38px) 42px}.masthead{display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:2px solid var(--ink);padding:0 0 14px}.brand{display:flex;align-items:center;gap:11px;color:inherit;text-decoration:none;min-width:0}.brand-mark{display:grid;place-items:center;flex:0 0 44px;width:44px;height:44px;border-radius:50%;background:var(--ink);color:var(--paper);font:800 16px var(--mono);letter-spacing:-.08em}.brand strong{display:block;font:700 18px var(--display);letter-spacing:.02em}.top-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.prefs{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.prefs label{display:grid;gap:3px;color:var(--muted);font:9px var(--mono);letter-spacing:.08em;text-transform:uppercase}.prefs select{border:1px solid var(--line);background:var(--panel);padding:6px 8px;min-width:94px}.executor{display:flex;align-items:center;gap:7px;border:1px solid var(--line);background:var(--panel);padding:7px 9px;font:10px var(--mono);white-space:nowrap}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--warn)}.dot.online{background:var(--ok)}.dot.offline{background:var(--bad)}
.button{border:1px solid var(--ink);background:var(--ink);color:var(--paper);padding:8px 11px;font:700 12px var(--body)}.button:hover{background:var(--accent);border-color:var(--accent)}.button.secondary{background:transparent;color:var(--ink)}.button.secondary:hover{background:var(--panel-2);border-color:var(--accent);color:var(--ink)}.button.danger{background:var(--bad);border-color:var(--bad);color:white}.button.quiet{border-color:var(--line);background:var(--panel);color:var(--ink)}.button.quiet:hover{border-color:var(--accent);background:var(--panel-2)}.button:disabled{opacity:.45;cursor:not-allowed}
.intro{display:flex;align-items:end;justify-content:space-between;gap:20px;padding:22px 0 16px;flex-wrap:wrap}.intro h1{margin:0;font:500 clamp(36px,6vw,68px)/.9 var(--serif);letter-spacing:-.045em}.intro h1 em{font-style:normal;color:var(--accent-2)}.lede{max-width:780px;margin:10px 0 0;color:var(--muted);line-height:1.55;font-size:13px}.filters{display:flex;gap:6px;flex-wrap:wrap}.filter{display:flex;align-items:center;gap:8px;border:1px solid var(--line);background:var(--panel);padding:9px 11px;font:700 11px var(--mono);letter-spacing:.05em;text-transform:uppercase}.filter strong{font-size:15px}.filter:hover{border-color:var(--accent)}.filter.active{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 13%,var(--panel))}.filter[data-filter="attention"] strong{color:var(--warn)}.filter[data-filter="running"] strong{color:var(--accent-2)}
.error{display:none;margin:10px 0;border-left:4px solid var(--bad);background:color-mix(in srgb,var(--bad) 12%,var(--panel));padding:10px 12px;color:var(--bad);font-size:12px}.error.visible{display:block}.experimental-notice{margin:12px 0 0;border-left:3px solid var(--accent-2);background:color-mix(in srgb,var(--accent-2) 7%,var(--panel));padding:7px 10px;color:var(--muted);font-size:11px;line-height:1.45}.workspace{display:grid;grid-template-columns:minmax(0,1.62fr) minmax(480px,1fr);gap:18px;align-items:start}.panel{border:1px solid var(--ink);background:var(--panel);box-shadow:var(--shadow);min-width:0}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid var(--line);padding:11px 13px}.panel-head h2{margin:0;font:700 12px var(--mono);letter-spacing:.1em;text-transform:uppercase}.panel-head small{color:var(--muted);font:10px var(--mono)}
.table-head{display:grid;grid-template-columns:minmax(140px,1.55fr) minmax(108px,1.15fr) 74px 48px minmax(82px,.9fr) 68px minmax(82px,.9fr) 96px minmax(72px,.8fr);gap:6px;padding:8px 12px;background:var(--panel-2);border-bottom:1px solid var(--line);color:var(--muted);font:9px var(--mono);letter-spacing:.07em;text-transform:uppercase}.task-list{max-height:calc(100vh - 250px);min-height:230px;overflow:auto}.task-row{width:100%;display:grid;grid-template-columns:minmax(140px,1.55fr) minmax(108px,1.15fr) 74px 48px minmax(82px,.9fr) 68px minmax(82px,.9fr) 96px minmax(72px,.8fr);gap:6px;align-items:center;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--ink);padding:11px 12px;text-align:left}.task-row:hover{background:var(--panel-2)}.task-row.selected{background:color-mix(in srgb,var(--accent) 12%,var(--panel));box-shadow:inset 3px 0 var(--accent)}.cell{min-width:0}.cell strong,.cell small,.cell span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.task-name{font:700 12px var(--mono)}.task-sub{color:var(--muted);font:10px var(--mono);margin-top:3px}.task-workspace{color:var(--muted);font:9px var(--mono);margin-top:2px}.tiny{color:var(--muted);font:9px var(--mono);letter-spacing:.04em}.status-chip,.chip{display:inline-flex;align-items:center;border:1px solid var(--line);background:var(--panel-2);color:var(--ink-soft);padding:3px 6px;font:700 9px var(--mono);letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}.status-chip.completed,.status-chip.released,.chip.ok{background:color-mix(in srgb,var(--ok) 19%,var(--panel));border-color:color-mix(in srgb,var(--ok) 45%,var(--line));color:var(--ok)}.status-chip.failed,.status-chip.cancelled,.chip.bad{background:color-mix(in srgb,var(--bad) 16%,var(--panel));border-color:color-mix(in srgb,var(--bad) 40%,var(--line));color:var(--bad)}.status-chip.running,.status-chip.waiting_for_master,.chip.warn{background:color-mix(in srgb,var(--warn) 18%,var(--panel));border-color:color-mix(in srgb,var(--warn) 40%,var(--line));color:var(--warn)}.status-chip.queued,.chip.info{background:color-mix(in srgb,var(--accent-2) 15%,var(--panel));border-color:color-mix(in srgb,var(--accent-2) 38%,var(--line));color:var(--accent-2)}.attention-mark{color:var(--warn);font:700 9px var(--mono);overflow:hidden;text-overflow:ellipsis}.empty{padding:28px;text-align:center;color:var(--muted);font-family:var(--serif);font-size:16px}
.detail-panel{min-height:320px}.detail-body{padding:13px}.detail-empty{padding:55px 20px;text-align:center;color:var(--muted);font-family:var(--serif);font-size:18px}.detail-hero{display:flex;align-items:start;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding-bottom:11px;margin-bottom:12px}.detail-hero h2{margin:0;font:700 14px var(--mono);overflow-wrap:anywhere}.detail-hero p{margin:5px 0 0;color:var(--muted);font-size:12px;line-height:1.45;overflow-wrap:anywhere}.hero-chips{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);margin:0 0 12px}.fact{background:var(--panel);padding:8px;min-width:0}.fact label{display:block;color:var(--muted);font:9px var(--mono);letter-spacing:.06em;text-transform:uppercase}.fact strong{display:block;margin-top:4px;font:11px var(--mono);overflow-wrap:anywhere;white-space:normal}
.section{border-top:1px solid var(--line);padding:12px 0 0;margin-top:13px}.section:first-of-type{border-top:0;margin-top:0;padding-top:0}.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:8px}.section-head h3{margin:0;font:700 11px var(--mono);letter-spacing:.1em;text-transform:uppercase}.section-head small{color:var(--muted);font:9px var(--mono);text-align:right}.notice{border-left:4px solid var(--warn);background:color-mix(in srgb,var(--warn) 12%,var(--panel));padding:9px 11px;margin:8px 0;font-size:11px;line-height:1.5}.notice.bad{border-color:var(--bad);background:color-mix(in srgb,var(--bad) 12%,var(--panel));color:var(--bad)}.notice.ok{border-color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,var(--panel))}.notice.info{border-color:var(--accent-2);background:color-mix(in srgb,var(--accent-2) 10%,var(--panel))}.muted{color:var(--muted)}.list{display:grid;gap:6px}.line-item{border:1px solid var(--line);background:var(--panel);padding:7px 8px;font-size:11px;overflow-wrap:anywhere}.line-item strong{font-family:var(--mono);font-size:10px}.detail-actions{display:flex;gap:6px;flex-wrap:wrap;margin:9px 0}.form-card{border:1px solid var(--line);background:var(--panel-2);padding:9px;margin:8px 0}.form-card label{display:grid;gap:4px;color:var(--muted);font:9px var(--mono);letter-spacing:.05em;text-transform:uppercase;margin-bottom:7px}.form-card textarea,.form-card input,.form-card select{width:100%;border:1px solid var(--line);background:var(--panel);padding:7px 8px;min-height:34px}.form-card textarea{min-height:76px;resize:vertical}.form-grid{display:grid;grid-template-columns:1fr 120px;gap:7px}.form-grid .wide{grid-column:1/-1}
.attempts{display:flex;gap:7px;overflow:auto;padding:2px 0 4px}.attempt{min-width:132px;border:1px solid var(--line);background:var(--panel);padding:7px 8px;text-align:left}.attempt:hover{border-color:var(--accent)}.attempt.active{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,var(--panel))}.attempt strong{display:block;font:700 11px var(--mono)}.attempt span{display:block;margin-top:3px;color:var(--muted);font:9px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.attempt .status-chip{margin-top:5px}
.result-summary{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.5}.usage-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line)}.usage-cell{background:var(--panel);padding:7px;min-width:0}.usage-cell label{display:block;color:var(--muted);font:8px var(--mono);letter-spacing:.05em;text-transform:uppercase}.usage-cell strong{display:block;margin-top:3px;font:11px var(--mono);overflow-wrap:anywhere}.usage-meta{display:flex;gap:5px;flex-wrap:wrap;margin:7px 0}.events summary{cursor:pointer;font:700 11px var(--mono);letter-spacing:.08em;text-transform:uppercase}.event-list{max-height:420px;overflow:auto;border:1px solid var(--line);margin-top:8px}.event-row{border-bottom:1px solid var(--line);padding:7px 8px;font-size:10px;overflow-wrap:anywhere}.event-row:last-child{border-bottom:0}.event-top{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}.event-seq{color:var(--muted);font:9px var(--mono)}.event-type{font:700 9px var(--mono);color:var(--accent-2)}.event-summary{margin-top:3px;line-height:1.45}.event-details summary{color:var(--muted);font:9px var(--mono);margin-top:4px}.event-details pre{max-height:180px;overflow:auto;background:var(--code);color:var(--code-ink);padding:7px;white-space:pre-wrap;overflow-wrap:anywhere;font:9px/1.45 var(--mono);margin:4px 0 0}.footer{display:flex;justify-content:space-between;gap:12px;margin-top:24px;border-top:1px solid var(--line);padding-top:10px;color:var(--muted);font:9px var(--mono);letter-spacing:.05em;text-transform:uppercase}
.toast{position:fixed;right:16px;bottom:16px;max-width:440px;background:var(--ink);color:var(--paper);padding:10px 13px;font:11px var(--mono);opacity:0;transform:translateY(8px);transition:.2s;pointer-events:none;z-index:40}.toast.show{opacity:1;transform:none}.toast.error{background:var(--bad);color:white}
dialog{border:1px solid var(--ink);background:var(--panel);color:var(--ink);padding:0;width:min(920px,calc(100vw - 28px));max-height:calc(100vh - 40px);box-shadow:var(--shadow)}dialog::backdrop{background:rgba(0,0,0,.38)}.dialog-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--panel-2)}.dialog-head h2{margin:0;font:700 12px var(--mono);letter-spacing:.08em;text-transform:uppercase}.dialog-body{padding:14px;overflow:auto;max-height:calc(100vh - 130px)}.diag-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.diag-card{border:1px solid var(--line);background:var(--panel);padding:10px;min-width:0}.diag-card h3{margin:0 0 5px;font:700 11px var(--mono)}.diag-card p{margin:0 0 8px;color:var(--muted);font-size:11px;line-height:1.45}.tag{display:inline-block;border:1px solid color-mix(in srgb,var(--warn) 40%,var(--line));background:color-mix(in srgb,var(--warn) 14%,var(--panel));color:var(--warn);padding:2px 5px;font:700 8px var(--mono);letter-spacing:.05em;text-transform:uppercase;vertical-align:middle}.diag-output{background:var(--code);color:var(--code-ink);padding:10px;white-space:pre-wrap;overflow-wrap:anywhere;font:10px/1.5 var(--mono);max-height:260px;overflow:auto;margin-top:10px}.diag-actions{display:flex;gap:5px;flex-wrap:wrap}.checkbox{display:flex;gap:7px;align-items:flex-start;font-size:11px;line-height:1.4;margin:7px 0}
@media(max-width:1180px){.workspace{grid-template-columns:1fr}.task-list{max-height:none}.table-head{display:none}.task-row{grid-template-columns:minmax(140px,1.6fr) minmax(110px,1.15fr) 80px 56px minmax(88px,1fr);row-gap:4px}.task-row .cell:nth-child(6){grid-column:1/2}.task-row .cell:nth-child(7){grid-column:2/4}.task-row .cell:nth-child(8){grid-column:4/5}.task-row .cell:nth-child(9){grid-column:5/6}.diag-grid{grid-template-columns:1fr}}
@media(max-width:700px){.masthead{display:block}.top-tools{margin-top:11px;justify-content:flex-start}.intro{display:block}.filters{margin-top:12px}.brand strong{font-size:16px}.task-row{display:block;padding:10px 11px}.task-row .cell{display:flex;justify-content:space-between;gap:12px;padding:3px 0}.task-row .cell:before{content:attr(data-label);color:var(--muted);font:8px var(--mono);letter-spacing:.06em;text-transform:uppercase}.task-row .cell:nth-child(6),.task-row .cell:nth-child(7),.task-row .cell:nth-child(8),.task-row .cell:nth-child(9){grid-column:auto}.facts,.usage-grid,.form-grid,.diag-grid{grid-template-columns:1fr}.form-grid .wide{grid-column:auto}.detail-hero{display:block}.hero-chips{justify-content:flex-start;margin-top:8px}.footer{display:block}.footer span{display:block;margin-top:5px}.section-head{display:block}.section-head small{display:block;text-align:left;margin-top:3px}}
.detail-panel .panel-head h2{text-transform:none}.task-workspace{direction:rtl;text-align:left}.provider-cost strong,.provider-cost .tiny{display:block}.provider-cost .tiny{margin-top:2px}

/* Preview.17 task-workspace pass: quiet surfaces, scannable inbox rows, evidence after actions. */
:root{
  --ink:#18201d;
  --ink-soft:#3d4843;
  --paper:#f3f4f1;
  --panel:#ffffff;
  --panel-2:#eef1ed;
  --line:#d9dfd9;
  --accent:#b84e2d;
  --accent-2:#146b5c;
  --ok:#216e4e;
  --warn:#9a5b13;
  --bad:#a5322b;
  --muted:#68736d;
  --code:#151c19;
  --code-ink:#eef2ea;
  --shadow:none;
  --display:"Aptos Display","Segoe UI Variable Display","Segoe UI",sans-serif;
  --body:"Aptos","Segoe UI Variable","Segoe UI",sans-serif;
  --serif:"Aptos Display","Segoe UI Variable Display","Segoe UI",sans-serif;
  --mono:"Cascadia Code","Consolas",monospace
}
:root[data-theme="dark"]{
  --ink:#edf1eb;
  --ink-soft:#c5cec7;
  --paper:#111714;
  --panel:#18201c;
  --panel-2:#202a25;
  --line:#35423b;
  --accent:#ef8a63;
  --accent-2:#63c7b5;
  --ok:#75c89a;
  --warn:#e3aa61;
  --bad:#ff9188;
  --muted:#9ca9a1;
  --code:#0b100e;
  --code-ink:#eef2ea
}
@media(prefers-color-scheme:dark){:root[data-theme="system"]{
  --ink:#edf1eb;--ink-soft:#c5cec7;--paper:#111714;--panel:#18201c;--panel-2:#202a25;--line:#35423b;
  --accent:#ef8a63;--accent-2:#63c7b5;--ok:#75c89a;--warn:#e3aa61;--bad:#ff9188;--muted:#9ca9a1;
  --code:#0b100e;--code-ink:#eef2ea
}}
body{background:var(--paper)}
body:before{display:none}
.shell{max-width:1580px;padding:18px clamp(16px,3vw,42px) 40px}
.masthead{border-bottom:1px solid var(--line);padding-bottom:13px}
.brand-mark{width:34px;height:34px;flex-basis:34px;border-radius:9px;font-size:12px;background:var(--accent-2)}
.brand strong{font:650 16px var(--display);letter-spacing:-.01em}
.executor{border:0;background:transparent;padding:4px 7px;color:var(--muted);font-size:10px}
.prefs label{font:9px var(--body);letter-spacing:.02em;text-transform:none}
.prefs select,.button{border-radius:7px}
.button{font:600 12px var(--body);padding:8px 12px}
.button.quiet{border-color:var(--line);background:transparent}
.intro{display:block;padding:24px 0 14px}
.intro h1{font:650 clamp(34px,5vw,52px)/1 var(--display);letter-spacing:-.035em}
.lede{max-width:720px;margin-top:8px;font-size:13px}
.experimental-notice{border:0;border-left:2px solid var(--accent-2);background:transparent;padding:5px 0 5px 10px;margin-top:10px}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0 0 16px}
.filter{display:flex;align-items:baseline;justify-content:space-between;border:1px solid var(--line);background:var(--panel);padding:13px 15px;border-radius:10px;font:600 12px var(--body);letter-spacing:0;text-transform:none;text-align:left}
.filter strong{font:650 25px/1 var(--display);letter-spacing:-.03em}
.filter:hover{border-color:color-mix(in srgb,var(--accent) 55%,var(--line));background:var(--panel)}
.filter.active{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent);background:color-mix(in srgb,var(--accent) 5%,var(--panel))}
.filter[data-filter="attention"].active{border-color:var(--warn);box-shadow:inset 0 0 0 1px var(--warn)}
.workspace{grid-template-columns:minmax(340px,.82fr) minmax(0,1.45fr);gap:14px}
.panel{border:1px solid var(--line);border-radius:11px;box-shadow:none;background:var(--panel)}
.panel-head{padding:12px 14px;border-bottom:1px solid var(--line)}
.panel-head h2{font:650 14px var(--display);letter-spacing:0;text-transform:none}
.panel-head small{font:11px var(--body)}
.table-head{display:none}
.task-list{max-height:calc(100vh - 300px);padding:0 8px 8px}
.task-row{display:block;position:relative;width:100%;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;padding:14px 10px 14px 13px;text-align:left}
.task-row:before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:2px;border-radius:2px;background:transparent}
.task-row:hover{background:color-mix(in srgb,var(--panel-2) 70%,var(--panel))}
.task-row.selected{background:color-mix(in srgb,var(--accent-2) 7%,var(--panel));box-shadow:none}
.task-row.selected:before{background:var(--accent-2)}
.task-row.attention{padding-left:15px}
.task-row.attention:before{background:var(--warn)}
.task-main{display:grid;gap:7px;min-width:0}
.task-row-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.task-title-wrap{display:grid;gap:3px;min-width:0}
.task-name{display:block;font:650 14px/1.35 var(--display);white-space:normal;overflow:visible;text-overflow:clip;color:var(--ink)}
.task-id{display:block;color:var(--muted);font:10px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.task-badges{display:flex;align-items:center;gap:5px;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end}
.status-chip,.chip{border-radius:999px;padding:3px 7px;font:650 9px var(--body);letter-spacing:.01em;text-transform:none}
.review-chip{border:1px solid color-mix(in srgb,var(--accent-2) 40%,var(--line));background:color-mix(in srgb,var(--accent-2) 8%,var(--panel));color:var(--accent-2);border-radius:999px;padding:3px 7px;font:650 9px var(--body);white-space:nowrap}
.review-chip.blocked{border-color:color-mix(in srgb,var(--warn) 48%,var(--line));background:color-mix(in srgb,var(--warn) 10%,var(--panel));color:var(--warn)}
.task-objective{display:block;color:var(--ink-soft);font:12px/1.45 var(--body);white-space:normal;overflow:visible;text-overflow:clip}
.task-workspace{display:block;color:var(--muted);font:10px/1.45 var(--mono);direction:ltr;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.task-meta-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--muted);font:10px var(--body)}
.task-meta-item{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.task-meta-item+.task-meta-item:before{content:"·";color:var(--line);margin-right:2px}
.task-summary-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}
.task-usage-line{color:var(--muted);font:10px/1.4 var(--body)}
.task-attention{display:flex;align-items:flex-start;gap:7px;border-radius:7px;background:color-mix(in srgb,var(--warn) 9%,var(--panel));color:var(--warn);padding:7px 8px;font:600 10px/1.45 var(--body)}
.task-attention:before{content:"!";display:grid;place-items:center;width:15px;height:15px;flex:0 0 15px;border:1px solid currentColor;border-radius:50%;font:700 9px var(--mono)}
.task-review-hint{color:var(--accent-2);font:600 10px/1.4 var(--body)}
.empty{padding:34px 22px;font:14px var(--body)}
.detail-panel{min-height:420px}
.detail-body{padding:16px 18px 20px}
.detail-empty{padding:64px 20px;font:14px var(--body)}
.detail-title{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding-bottom:12px;border-bottom:1px solid var(--line);margin-bottom:4px}
.detail-title h2{margin:0;font:650 20px/1.25 var(--display);overflow-wrap:anywhere}
.detail-title p{margin:5px 0 0;color:var(--muted);font:12px/1.5 var(--body);overflow-wrap:anywhere}
.hero-chips{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
.facts{grid-template-columns:repeat(2,minmax(0,1fr));gap:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-bottom:0;background:var(--line)}
.fact{padding:9px 10px}
.fact label{font:9px var(--body);letter-spacing:.02em;text-transform:none}
.fact strong{font:11px/1.45 var(--mono)}
.section{border-top:1px solid var(--line);padding:15px 0 0;margin-top:15px}
.section-head{align-items:center;margin-bottom:9px}
.section-head h3{font:650 13px var(--display);letter-spacing:-.01em;text-transform:none}
.section-head small{font:10px var(--body);max-width:48%;line-height:1.35}
.detail-actions{gap:7px;margin:0}
.detail-actions .button:first-child{min-width:124px}
.action-note{margin-top:7px;color:var(--muted);font-size:11px;line-height:1.45}
.notice{border:0;border-left:2px solid var(--warn);border-radius:0 6px 6px 0;background:color-mix(in srgb,var(--warn) 7%,var(--panel));padding:8px 10px;font:11px/1.5 var(--body)}
.notice.bad{border-color:var(--bad);background:color-mix(in srgb,var(--bad) 7%,var(--panel))}
.notice.ok{border-color:var(--ok);background:color-mix(in srgb,var(--ok) 7%,var(--panel))}
.notice.info{border-color:var(--accent-2);background:color-mix(in srgb,var(--accent-2) 6%,var(--panel))}
.attempts{gap:8px;padding-top:1px}
.attempt{min-width:145px;border-radius:8px;padding:9px 10px}
.attempt strong{font:650 11px var(--body)}
.attempt span{font:9px var(--mono)}
.result-summary{font:12px/1.6 var(--body);padding:2px 0}
.line-item{border:0;border-bottom:1px solid var(--line);background:transparent;border-radius:0;padding:7px 2px;font:11px/1.5 var(--body)}
.line-item:last-child{border-bottom:0}
.usage-board{display:grid;gap:10px}
.usage-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}
.usage-fact{border:1px solid var(--line);border-radius:8px;padding:9px 10px;min-width:0;background:color-mix(in srgb,var(--panel-2) 25%,var(--panel))}
.usage-fact label{display:block;color:var(--muted);font:9px var(--body);margin-bottom:4px}
.usage-fact strong{display:block;font:650 14px/1.2 var(--display);overflow-wrap:anywhere}
.usage-columns{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.usage-column{border:1px solid var(--line);border-radius:8px;padding:10px;min-width:0}
.usage-column h4{margin:0 0 7px;font:650 11px var(--body)}
.usage-column .line-item{font-size:10px}
.usage-meta{gap:5px;margin:0}
.provider-cost{border:1px solid var(--line);border-radius:8px;padding:9px 10px;background:color-mix(in srgb,var(--panel-2) 22%,var(--panel))}
.provider-cost strong{font:600 11px var(--body)}
.events{border-top:1px solid var(--line);padding-top:15px;margin-top:15px}
.events summary{font:650 13px var(--display);letter-spacing:-.01em;text-transform:none}
.execution-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:9px}
.execution-fact{border:1px solid var(--line);border-radius:8px;padding:10px;min-width:0}
.execution-fact h4{margin:0 0 5px;font:650 11px var(--body)}
.execution-fact .tiny{margin-top:4px}
.footer{border-top:0;margin-top:18px;font:9px var(--body);text-transform:none;letter-spacing:0}
@media(max-width:1180px){
  .workspace{grid-template-columns:1fr}
  .task-list{max-height:none}
  .task-row{display:block}
  .execution-facts{grid-template-columns:1fr}
}
@media(max-width:700px){
  .stats{grid-template-columns:1fr}
  .shell{padding:14px 12px 30px}
  .intro{padding-top:18px}
  .task-row{padding:13px 8px 13px 12px}
  .task-row-head{display:grid}
  .task-badges{justify-content:flex-start}
  .task-summary-row{display:grid}
  .detail-body{padding:14px}
  .detail-title{display:grid}
  .hero-chips{justify-content:flex-start}
  .facts,.usage-summary,.usage-columns{grid-template-columns:1fr}
  .section-head{display:flex}
  .section-head small{max-width:45%}
}

/* Preview.17 final task-workspace composition. */
body{background:var(--paper);font:14px/1.45 var(--body);color:var(--ink)}
.shell{max-width:1560px;padding:16px clamp(16px,3vw,40px) 36px}
.masthead{border-bottom:1px solid var(--line);padding-bottom:12px}
.brand-mark{width:32px;height:32px;flex-basis:32px;border-radius:8px;background:var(--accent-2);color:var(--panel);font:700 12px var(--mono)}
.brand strong{font:650 16px/1.2 var(--display);letter-spacing:-.015em}
.top-tools{gap:10px}
.executor{border:0;background:transparent;padding:4px 2px;color:var(--muted);font:10px var(--mono);opacity:.82}
.prefs label{font:10px var(--body);color:var(--muted);letter-spacing:0;text-transform:none}
.prefs select{border:1px solid var(--line);border-radius:7px;background:var(--panel);padding:5px 7px;min-width:88px;font-size:11px}
.button{border-radius:7px;padding:8px 12px;font:600 12px var(--body)}
.button.secondary{background:var(--panel)}
.intro{padding:25px 0 16px}
.intro h1{font:640 clamp(34px,4.6vw,48px)/1 var(--display);letter-spacing:-.04em}
.lede{margin-top:8px;max-width:640px;color:var(--muted);font-size:13px;line-height:1.5}
.experimental-notice{margin:11px 0 0;border-left:2px solid var(--accent-2);background:transparent;padding:4px 0 4px 9px;color:var(--muted);font-size:11px}
.stats{gap:10px;margin:0 0 16px}
.filter{min-height:62px;border:1px solid var(--line);border-radius:9px;background:var(--panel);padding:10px 13px;color:var(--ink)}
.filter span{color:var(--muted);font:11px var(--body)}
.filter strong{font:650 24px/1 var(--display);letter-spacing:-.03em}
.filter.active{border-color:color-mix(in srgb,var(--accent-2) 55%,var(--line));box-shadow:inset 0 0 0 1px var(--accent-2);background:color-mix(in srgb,var(--accent-2) 5%,var(--panel))}
.workspace{grid-template-columns:minmax(330px,.68fr) minmax(0,1fr);gap:16px;align-items:start}
.panel{border:1px solid var(--line);border-radius:11px;background:var(--panel);box-shadow:none}
.panel-head{min-height:50px;padding:11px 14px;border-bottom:1px solid var(--line)}
.panel-head h2{font:650 14px/1.2 var(--display);letter-spacing:-.01em;text-transform:none}
.panel-head small{font:11px var(--body);color:var(--muted)}
.task-list{max-height:calc(100vh - 315px);min-height:240px;padding:3px 6px 8px}
.task-row{display:block;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;padding:13px 10px 13px 13px}
.task-row:last-child{border-bottom:0}
.task-row:hover{background:color-mix(in srgb,var(--panel-2) 68%,var(--panel))}
.task-row.selected{background:color-mix(in srgb,var(--accent-2) 6%,var(--panel));box-shadow:none}
.task-row.selected:before{background:var(--accent-2)}
.task-row.attention{background:color-mix(in srgb,var(--warn) 4%,var(--panel));padding-left:15px}
.task-row.attention:before{background:var(--warn)}
.task-main{display:grid;gap:7px;min-width:0}
.task-row-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.task-title-wrap{display:grid;gap:2px;min-width:0}
.task-name{display:block;overflow:visible;color:var(--ink);font:650 14px/1.35 var(--display);white-space:normal;text-overflow:clip}
.task-id{display:block;overflow:hidden;color:var(--muted);font:10px var(--mono);text-overflow:ellipsis;white-space:nowrap}
.task-badges{display:flex;align-items:center;justify-content:flex-end;gap:5px;flex:0 0 auto;flex-wrap:wrap}
.status-chip,.chip{border-radius:999px;padding:3px 7px;font:650 9px var(--body);letter-spacing:.01em;text-transform:none}
.review-chip{border-radius:999px;padding:3px 7px;font:650 9px var(--body)}
.task-objective{display:block;color:var(--ink-soft);font:12px/1.45 var(--body);white-space:normal}
.task-meta-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap;color:var(--muted);font:10px/1.4 var(--body)}
.task-meta-item{display:inline-flex;align-items:center;white-space:nowrap}
.task-meta-item+.task-meta-item:before{content:"·";margin-right:2px;color:var(--line)}
.task-workspace{display:block;overflow:hidden;color:var(--muted);font:10px/1.4 var(--mono);direction:ltr;text-align:left;text-overflow:ellipsis;white-space:nowrap}
.task-summary-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}
.task-usage-line{color:var(--muted);font:10px/1.4 var(--body)}
.task-review-hint{color:var(--accent-2);font:600 10px/1.4 var(--body)}
.task-review-hint.blocked{color:var(--warn)}
.task-attention{display:flex;align-items:flex-start;gap:7px;border-radius:6px;background:color-mix(in srgb,var(--warn) 8%,var(--panel));padding:6px 7px;color:var(--warn);font:600 10px/1.45 var(--body)}
.task-attention:before{content:"!";display:grid;place-items:center;width:14px;height:14px;flex:0 0 14px;border:1px solid currentColor;border-radius:50%;font:700 9px var(--mono)}
.empty{padding:34px 20px;color:var(--muted);font:13px var(--body);text-align:center}
.detail-panel{min-height:430px}
.detail-body{padding:16px 18px 20px}
.detail-empty{padding:64px 20px;color:var(--muted);font:14px var(--body);text-align:center}
.detail-title{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding-bottom:13px;border-bottom:1px solid var(--line);margin-bottom:2px}
.detail-title-main{min-width:0}
.detail-title h2{margin:0;font:650 21px/1.25 var(--display);letter-spacing:-.025em;overflow-wrap:anywhere}
.detail-title p{margin:5px 0 0;color:var(--ink-soft);font:12px/1.5 var(--body);overflow-wrap:anywhere}
.detail-context{display:flex;align-items:center;gap:6px;min-width:0;margin-top:7px;color:var(--muted);font:10px var(--mono)}
.detail-context-sep{color:var(--line)}
.detail-workspace{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hero-chips{display:flex;align-items:center;justify-content:flex-end;gap:5px;flex:0 0 auto;flex-wrap:wrap}
.facts{grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;border:1px solid var(--line);border-radius:7px;overflow:hidden;background:var(--line)}
.fact{padding:8px 10px;background:var(--panel)}
.fact label{font:9px var(--body);letter-spacing:0;text-transform:none}
.fact strong{font:11px/1.45 var(--mono);font-weight:500}
.section{border-top:1px solid var(--line);padding:14px 0 0;margin-top:14px}
.section:first-of-type{border-top:0;margin-top:0;padding-top:0}
.section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.section-head h3{font:650 13px/1.25 var(--display);letter-spacing:-.01em;text-transform:none}
.section-head small{max-width:52%;color:var(--muted);font:10px/1.35 var(--body);text-align:right}
.detail-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:0}
.detail-actions .button:first-child{min-width:118px}
.action-hint{margin-top:7px;color:var(--muted);font:11px/1.45 var(--body)}
.action-empty{color:var(--muted);font:11px/1.45 var(--body)}
.notice{border:0;border-left:2px solid var(--warn);border-radius:0 6px 6px 0;padding:8px 10px;font:11px/1.5 var(--body)}
.notice.bad{border-color:var(--bad)}
.notice.ok{border-color:var(--ok)}
.notice.info{border-color:var(--accent-2)}
.muted{color:var(--muted)}
.attempts{display:flex;gap:7px;overflow:auto;padding:1px 0 3px}
.attempt{min-width:142px;border:1px solid var(--line);border-radius:7px;background:var(--panel);padding:8px 9px;text-align:left}
.attempt:hover{border-color:color-mix(in srgb,var(--accent-2) 45%,var(--line))}
.attempt.active{border-color:var(--accent-2);background:color-mix(in srgb,var(--accent-2) 6%,var(--panel))}
.attempt strong{display:block;font:650 11px var(--body)}
.attempt span{display:block;margin-top:2px;overflow:hidden;color:var(--muted);font:9px var(--mono);text-overflow:ellipsis;white-space:nowrap}
.attempt .status-chip{margin-top:5px}
.result-summary{padding:2px 0;font:12px/1.6 var(--body);white-space:pre-wrap;overflow-wrap:anywhere}
.line-item{border:0;border-bottom:1px solid var(--line);background:transparent;padding:7px 1px;font:11px/1.5 var(--body)}
.line-item:last-child{border-bottom:0}
.usage-board{display:grid;gap:10px}
.usage-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.usage-identity strong{display:block;font:600 12px var(--body)}
.usage-identity .tiny{margin-top:2px}
.usage-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin:0}
.usage-columns{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(150px,.7fr);gap:9px}
.usage-column{border:1px solid var(--line);border-radius:8px;padding:10px;min-width:0;background:color-mix(in srgb,var(--panel-2) 18%,var(--panel))}
.usage-column h4{margin:0 0 7px;font:650 11px var(--body)}
.usage-column>strong{display:block;font:650 13px var(--display)}
.usage-column .tiny{margin-top:6px}
.usage-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
.usage-fact{border:1px solid var(--line);border-radius:6px;padding:7px 8px;min-width:0;background:var(--panel)}
.usage-fact label{display:block;margin-bottom:3px;color:var(--muted);font:9px var(--body)}
.usage-fact strong{display:block;font:650 14px/1.2 var(--display);overflow-wrap:anywhere}
.provider-cost{border:1px solid var(--line);border-radius:8px;padding:9px 10px;background:color-mix(in srgb,var(--panel-2) 18%,var(--panel))}
.provider-cost strong{display:block;font:600 11px var(--body)}
.provider-cost .tiny{margin-top:3px}
.events.section,.section-evidence{display:block}
.section-summary{display:flex;align-items:baseline;justify-content:space-between;gap:10px;cursor:pointer;list-style:none}
.section-summary::-webkit-details-marker{display:none}
.section-summary:after{content:"+";margin-left:auto;color:var(--muted);font:600 15px var(--mono)}
details[open]>.section-summary:after{content:"−"}
.section-title{font:650 13px/1.25 var(--display);letter-spacing:-.01em}
.section-subtitle{color:var(--muted);font:10px/1.35 var(--body);text-align:right}
.evidence-body{padding-top:10px}
.execution-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.execution-fact{border:1px solid var(--line);border-radius:8px;padding:9px 10px;min-width:0}
.execution-fact h4{margin:0 0 5px;font:650 11px var(--body)}
.execution-fact strong{display:block;font:600 12px/1.4 var(--body)}
.fact-detail{margin-top:3px;color:var(--muted);font:9px/1.45 var(--mono);overflow-wrap:anywhere}
.execution-fact .notice{margin-top:7px}
.event-list{max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:7px;margin-top:8px}
.event-row{border-bottom:1px solid var(--line);padding:7px 8px;font-size:10px}
.event-row:last-child{border-bottom:0}
.event-top{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}
.event-seq{color:var(--muted);font:9px var(--mono)}
.event-type{color:var(--accent-2);font:700 9px var(--mono)}
.event-summary{margin-top:3px;line-height:1.45}
.event-details summary{color:var(--muted);font:9px var(--mono);margin-top:4px}
.event-details pre{max-height:180px;overflow:auto;margin:4px 0 0;padding:7px;background:var(--code);color:var(--code-ink);font:9px/1.45 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.footer{border-top:0;margin-top:16px;padding-top:0;color:var(--muted);font:9px var(--body);letter-spacing:0;text-transform:none}
@media(max-width:1180px){
  .workspace{grid-template-columns:1fr}
  .task-list{max-height:none}
  .execution-facts{grid-template-columns:1fr}
}
@media(max-width:700px){
  .shell{padding:13px 12px 28px}
  .stats{grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
  .filter{min-height:54px;padding:8px 9px}
  .filter span{font-size:9px}
  .filter strong{font-size:20px}
  .intro{padding-top:18px}
  .intro h1{font-size:34px}
  .task-row{padding:12px 8px 12px 12px}
  .task-row-head{display:grid}
  .task-badges{justify-content:flex-start}
  .task-summary-row{display:grid}
  .detail-body{padding:14px}
  .detail-title{display:grid}
  .hero-chips{justify-content:flex-start}
  .facts,.usage-summary,.usage-columns{grid-template-columns:1fr}
  .attempts{flex-wrap:wrap;overflow:visible}
  .attempt{min-width:calc(50% - 4px);flex:1 1 calc(50% - 4px)}
  .detail-panel{scroll-margin-top:10px}
  .section-head{display:block}
  .section-head small{display:block;max-width:none;margin-top:3px;text-align:left}
  .section-summary{display:grid;gap:3px}
  .section-subtitle{text-align:left}
}

/* Preview.17 final task-workspace composition: compact inbox, task-first detail, quiet evidence. */
:root{
  --ink:#17201c;
  --ink-soft:#3d4842;
  --paper:#f5f7f4;
  --panel:#ffffff;
  --panel-2:#eef2ee;
  --line:#dbe2dc;
  --accent:#0d6b5c;
  --accent-2:#0d6b5c;
  --primary:#245fc0;
  --ok:#1f704b;
  --warn:#a45b10;
  --bad:#a72f2a;
  --muted:#69746e;
  --code:#111815;
  --code-ink:#eef3ec;
  --shadow:none;
  --display:"Aptos Display","Segoe UI Variable Display","Segoe UI",sans-serif;
  --body:"Aptos","Segoe UI Variable","Segoe UI",sans-serif;
  --serif:var(--display);
  --mono:"Cascadia Code","Consolas",monospace
}
:root[data-theme="dark"]{
  --ink:#edf1eb;
  --ink-soft:#c5cec7;
  --paper:#0e1411;
  --panel:#171f1b;
  --panel-2:#202923;
  --line:#334039;
  --accent:#68c8b5;
  --accent-2:#68c8b5;
  --primary:#6ea8ff;
  --ok:#7bcaa0;
  --warn:#e0a45d;
  --bad:#ff9188;
  --muted:#9ca9a1;
  --code:#090f0c;
  --code-ink:#eef3ec
}
@media(prefers-color-scheme:dark){:root[data-theme="system"]{
  --ink:#edf1eb;--ink-soft:#c5cec7;--paper:#0e1411;--panel:#171f1b;--panel-2:#202923;--line:#334039;
  --accent:#68c8b5;--accent-2:#68c8b5;--primary:#6ea8ff;--ok:#7bcaa0;--warn:#e0a45d;--bad:#ff9188;--muted:#9ca9a1;
  --code:#090f0c;--code-ink:#eef3ec
}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;min-height:100vh;background:var(--paper);color:var(--ink);font:14px/1.45 var(--body)}
body:before{display:none}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
.mono,code,pre{font-family:var(--mono)}
.shell{max-width:1540px;margin:0 auto;padding:0 clamp(16px,3vw,40px) 34px}
.masthead{display:flex;align-items:center;justify-content:space-between;gap:18px;min-height:64px;border-bottom:1px solid var(--line);padding:10px 0}
.brand{display:flex;align-items:center;gap:10px;min-width:0;color:inherit;text-decoration:none}
.brand-mark{display:grid;place-items:center;flex:0 0 32px;width:32px;height:32px;padding:2px;border:1px solid var(--line);border-radius:8px;background:#fff;overflow:hidden}
.brand-icon{display:block;width:100%;height:100%;object-fit:contain}
.brand strong{display:block;font:650 16px/1.2 var(--display);letter-spacing:-.015em;white-space:nowrap}
.experimental-pill{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;background:var(--panel-2);padding:3px 7px;color:var(--muted);font:600 9px/1.2 var(--body);letter-spacing:.02em}
.top-tools{display:flex;align-items:center;justify-content:flex-end;gap:9px;flex-wrap:wrap}
.executor{display:flex;align-items:center;gap:6px;border:0;background:transparent;padding:3px 2px;color:var(--muted);font:10px var(--mono);opacity:.82;white-space:nowrap}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--warn)}
.dot.online{background:var(--ok)}
.dot.offline{background:var(--bad)}
.prefs{display:flex;align-items:flex-end;gap:8px}
.prefs label{display:grid;gap:2px;color:var(--muted);font:9px/1.2 var(--body);letter-spacing:0;text-transform:none}
.prefs select{border:1px solid var(--line);border-radius:7px;background:var(--panel);padding:5px 7px;min-width:86px;font-size:11px}
.button{border:1px solid var(--primary);border-radius:7px;background:var(--primary);color:#fff;padding:8px 12px;font:600 12px var(--body)}
.button:hover{filter:brightness(.95)}
.button.secondary{border-color:var(--line);background:var(--panel);color:var(--ink)}
.button.secondary:hover{border-color:var(--primary);background:color-mix(in srgb,var(--primary) 5%,var(--panel));color:var(--ink);filter:none}
.button.danger{border-color:var(--bad);background:var(--bad);color:#fff}
.button.quiet{border-color:var(--line);background:transparent;color:var(--ink)}
.button.quiet:hover{border-color:var(--primary);background:color-mix(in srgb,var(--primary) 5%,var(--panel));filter:none}
.button:disabled{opacity:.45;cursor:not-allowed}
.icon-button{font-size:10px;padding:5px 7px}
.page-head{display:grid;grid-template-columns:minmax(330px,.68fr) minmax(0,1fr);gap:16px;align-items:end;padding:24px 0 16px}
.intro{min-width:0}
.intro h1{margin:0;font:640 clamp(34px,4.5vw,46px)/1 var(--display);letter-spacing:-.04em}
.lede{max-width:640px;margin:8px 0 0;color:var(--muted);font:13px/1.5 var(--body)}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin:0}
.filter{display:flex;align-items:center;justify-content:flex-start;gap:10px;min-height:70px;border:1px solid var(--line);border-radius:9px;background:var(--panel);padding:9px 11px;color:var(--ink);text-align:left;letter-spacing:0;text-transform:none}
.filter:hover{border-color:color-mix(in srgb,var(--primary) 45%,var(--line));background:var(--panel)}
.filter.active{border-color:color-mix(in srgb,var(--primary) 60%,var(--line));box-shadow:inset 0 0 0 1px var(--primary);background:color-mix(in srgb,var(--primary) 4%,var(--panel))}
.stat-icon{display:grid;place-items:center;flex:0 0 27px;width:27px;height:27px;border-radius:7px}
.stat-icon svg{width:17px;height:17px;fill:currentColor}
.filter-running .stat-icon{background:color-mix(in srgb,var(--primary) 11%,var(--panel));color:var(--primary)}
.filter-attention .stat-icon{background:color-mix(in srgb,var(--warn) 12%,var(--panel));color:var(--warn)}
.filter-completed .stat-icon{background:color-mix(in srgb,var(--ok) 12%,var(--panel));color:var(--ok)}
.stat-copy{display:grid;flex:1;justify-items:start;gap:3px;min-width:0;text-align:left}
.stat-copy>span{color:var(--muted);font:10px/1.2 var(--body);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stat-copy strong{font:650 23px/1 var(--display);letter-spacing:-.03em}
.filter-attention .stat-copy strong{color:var(--warn)}
.filter-running .stat-copy strong{color:var(--primary)}
.filter-completed .stat-copy strong{color:var(--ok)}
.error{display:none;margin:0 0 12px;border-left:3px solid var(--bad);background:color-mix(in srgb,var(--bad) 7%,var(--panel));padding:9px 11px;color:var(--bad);font-size:11px}
.error.visible{display:block}
.workspace{display:grid;grid-template-columns:minmax(340px,.68fr) minmax(0,1fr);gap:14px;align-items:start}
.panel{min-width:0;border:1px solid var(--line);border-radius:10px;background:var(--panel);box-shadow:none;overflow:hidden}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:52px;border-bottom:1px solid var(--line);padding:9px 13px}
.panel-title{display:flex;align-items:baseline;gap:8px;min-width:0}
.panel-head h2{margin:0;font:650 14px/1.2 var(--display);letter-spacing:-.01em;text-transform:none;white-space:nowrap}
.panel-head small{color:var(--muted);font:10px var(--body);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.list-tools{display:flex;align-items:center;gap:8px}
.sort-label{color:var(--muted);font:9px var(--body);white-space:nowrap}
.inbox-tools{display:grid;grid-template-columns:minmax(0,1fr) 126px;gap:7px;border-bottom:1px solid var(--line);padding:9px 12px}
.search-box{position:relative;display:block;min-width:0}
.search-icon{position:absolute;left:9px;top:50%;width:14px;height:14px;transform:translateY(-50%);fill:var(--muted);pointer-events:none}
.search-box input{width:100%;height:33px;border:1px solid var(--line);border-radius:7px;background:var(--panel);padding:6px 9px 6px 29px;font:11px var(--body)}
.search-box input::placeholder{color:var(--muted)}
.bucket-filter{width:100%;height:33px;border:1px solid var(--line);border-radius:7px;background:var(--panel);padding:5px 7px;font:11px var(--body)}
.task-list{max-height:calc(100vh - 342px);min-height:240px;overflow:auto;padding:0}
.task-row{position:relative;display:block;width:100%;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;padding:10px 10px 10px 13px;color:var(--ink);text-align:left}
.task-row:last-child{border-bottom:0}
.task-row:before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:0 3px 3px 0;background:transparent}
.task-row:hover{background:color-mix(in srgb,var(--panel-2) 66%,var(--panel))}
.task-row.selected{background:color-mix(in srgb,var(--primary) 5%,var(--panel));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--primary) 35%,var(--line))}
.task-row.selected:before{background:var(--primary)}
.task-row.attention{background:color-mix(in srgb,var(--warn) 4%,var(--panel))}
.task-row.attention:before{background:var(--warn)}
.task-row.completed:not(.attention):before{background:var(--ok)}
.task-row.running:not(.attention):before{background:var(--warn)}
.task-row.queued:not(.attention):before{background:var(--primary)}
.task-main{display:grid;gap:4px;min-width:0}
.task-row-head{display:flex;align-items:flex-start;justify-content:space-between;gap:9px;min-width:0}
.task-title-wrap{display:grid;gap:1px;min-width:0}
.task-name{display:-webkit-box;overflow:hidden;color:var(--ink);font:650 13.5px/1.32 var(--display);white-space:normal;text-overflow:clip;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.task-id{display:block;overflow:hidden;color:var(--muted);font:9.5px var(--mono);text-overflow:ellipsis;white-space:nowrap}
.task-badges{display:flex;align-items:center;justify-content:flex-end;gap:4px;flex:0 0 auto;flex-wrap:wrap}
.status-chip,.chip{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;background:var(--panel-2);color:var(--ink-soft);padding:3px 7px;font:650 9px/1.2 var(--body);letter-spacing:.01em;text-transform:none;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.status-chip.completed,.status-chip.released,.chip.ok{background:color-mix(in srgb,var(--ok) 11%,var(--panel));border-color:color-mix(in srgb,var(--ok) 35%,var(--line));color:var(--ok)}
.status-chip.failed,.status-chip.cancelled,.chip.bad{background:color-mix(in srgb,var(--bad) 10%,var(--panel));border-color:color-mix(in srgb,var(--bad) 32%,var(--line));color:var(--bad)}
.status-chip.running,.status-chip.waiting_for_master,.chip.warn{background:color-mix(in srgb,var(--warn) 11%,var(--panel));border-color:color-mix(in srgb,var(--warn) 34%,var(--line));color:var(--warn)}
.status-chip.queued,.chip.info{background:color-mix(in srgb,var(--primary) 9%,var(--panel));border-color:color-mix(in srgb,var(--primary) 30%,var(--line));color:var(--primary)}
.review-chip{border:1px solid color-mix(in srgb,var(--accent) 32%,var(--line));border-radius:999px;background:color-mix(in srgb,var(--accent) 7%,var(--panel));padding:3px 7px;color:var(--accent);font:650 9px/1.2 var(--body);white-space:nowrap}
.review-chip.blocked{border-color:color-mix(in srgb,var(--warn) 36%,var(--line));background:color-mix(in srgb,var(--warn) 8%,var(--panel));color:var(--warn)}
.task-meta-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-width:0;color:var(--muted);font:9.5px/1.35 var(--body)}
.task-meta-item{display:inline-flex;align-items:center;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.task-meta-item+.task-meta-item:before{content:"·";margin-right:2px;color:var(--line)}
.task-workspace{display:block;overflow:hidden;color:var(--muted);font:10px/1.4 var(--mono);direction:ltr;text-align:left;text-overflow:ellipsis;white-space:nowrap}
.task-summary-row{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap}
.task-usage-line{color:var(--muted);font:9.5px/1.4 var(--body)}
.task-attention{display:flex;align-items:flex-start;gap:6px;border-radius:6px;background:color-mix(in srgb,var(--warn) 8%,var(--panel));padding:5px 7px;color:var(--warn);font:600 9.5px/1.4 var(--body)}
.task-attention:before{content:"!";display:grid;place-items:center;width:13px;height:13px;flex:0 0 13px;border:1px solid currentColor;border-radius:50%;font:700 8px var(--mono)}
.empty{padding:34px 20px;color:var(--muted);font:13px var(--body);text-align:center}
.detail-panel{min-height:430px}
.detail-body{padding:15px 17px 20px}
.detail-empty{padding:64px 20px;color:var(--muted);font:14px var(--body);text-align:center}
.detail-title{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding-bottom:11px}
.detail-title-main{min-width:0}
.detail-title h2{margin:0;font:650 22px/1.22 var(--display);letter-spacing:-.025em;overflow-wrap:anywhere}
.detail-title p{margin:4px 0 0;color:var(--ink-soft);font:12px/1.5 var(--body);overflow-wrap:anywhere}
.detail-context{display:flex;align-items:center;gap:6px;min-width:0;margin-top:6px;color:var(--muted);font:10px var(--mono)}
.detail-context-sep{color:var(--line)}
.detail-workspace{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hero-chips{display:flex;align-items:center;justify-content:flex-end;gap:4px;flex:0 0 auto;flex-wrap:wrap}
.facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;margin:0;background:var(--line)}
.fact{padding:8px 10px;min-width:0;background:var(--panel)}
.fact label{display:block;margin-bottom:3px;color:var(--muted);font:9px/1.2 var(--body)}
.fact strong{display:block;color:var(--ink);font:500 10.5px/1.45 var(--mono);overflow-wrap:anywhere;white-space:normal}
.section{border-top:1px solid var(--line);padding:14px 0 0;margin-top:14px}
.section:first-of-type{border-top:0;margin-top:10px;padding-top:0}
.section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.section-head h3{margin:0;font:650 13px/1.25 var(--display);letter-spacing:-.01em;text-transform:none}
.section-head small{max-width:55%;color:var(--muted);font:10px/1.35 var(--body);text-align:right}
.detail-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:0}
.detail-actions .button:first-child{min-width:112px}
.action-hint{margin-top:6px;color:var(--muted);font:10.5px/1.45 var(--body)}
.action-empty{color:var(--muted);font:11px/1.45 var(--body)}
.notice{border:0;border-left:3px solid var(--warn);border-radius:0 6px 6px 0;background:color-mix(in srgb,var(--warn) 7%,var(--panel));padding:8px 10px;font:11px/1.5 var(--body);white-space:pre-wrap}
.notice.bad{border-color:var(--bad);background:color-mix(in srgb,var(--bad) 7%,var(--panel));color:var(--bad)}
.notice.ok{border-color:var(--ok);background:color-mix(in srgb,var(--ok) 6%,var(--panel))}
.notice.info{border-color:var(--primary);background:color-mix(in srgb,var(--primary) 5%,var(--panel))}
.muted{color:var(--muted)}
.list{display:grid;gap:0}
.line-item{border:0;border-bottom:1px solid var(--line);background:transparent;padding:6px 1px;font:11px/1.5 var(--body);overflow-wrap:anywhere}
.line-item:last-child{border-bottom:0}
.form-card{border:1px solid var(--line);border-radius:8px;background:color-mix(in srgb,var(--panel-2) 30%,var(--panel));padding:10px;margin:9px 0}
.form-card label{display:grid;gap:4px;margin-bottom:8px;color:var(--muted);font:9px var(--body);letter-spacing:0;text-transform:none}
.form-card textarea,.form-card input,.form-card select{width:100%;min-height:33px;border:1px solid var(--line);border-radius:6px;background:var(--panel);padding:6px 8px;font-size:11px}
.form-card textarea{min-height:72px;resize:vertical}
.form-grid{display:grid;grid-template-columns:1fr 120px;gap:7px}
.form-grid .wide{grid-column:1/-1}
.attempts{display:flex;gap:7px;overflow:auto;padding:1px 0 3px}
.attempt{min-width:138px;border:1px solid var(--line);border-radius:7px;background:var(--panel);padding:8px 9px;text-align:left}
.attempt:hover{border-color:color-mix(in srgb,var(--primary) 40%,var(--line))}
.attempt.active{border-color:var(--primary);background:color-mix(in srgb,var(--primary) 5%,var(--panel))}
.attempt strong{display:block;font:650 11px var(--body)}
.attempt span{display:block;margin-top:2px;overflow:hidden;color:var(--muted);font:9px var(--mono);text-overflow:ellipsis;white-space:nowrap}
.attempt .status-chip{margin-top:5px}
.result-summary{padding:1px 0;font:12px/1.6 var(--body);white-space:pre-wrap;overflow-wrap:anywhere}
.tiny{color:var(--muted);font:9px/1.4 var(--mono);letter-spacing:.01em}
.usage-board{display:grid;gap:9px}
.usage-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}
.usage-identity strong{display:block;font:600 11.5px var(--body)}
.usage-identity .tiny{margin-top:2px}
.usage-meta{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin:0}
.usage-columns{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(150px,.7fr);gap:8px}
.usage-column{border:1px solid var(--line);border-radius:8px;padding:9px;min-width:0;background:color-mix(in srgb,var(--panel-2) 18%,var(--panel))}
.usage-column h4{margin:0 0 6px;font:650 10.5px var(--body)}
.usage-column>strong{display:block;font:650 12px var(--display)}
.usage-column .tiny{margin-top:6px}
.usage-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}
.usage-fact{border:1px solid var(--line);border-radius:6px;padding:6px 7px;min-width:0;background:var(--panel)}
.usage-fact label{display:block;margin-bottom:2px;color:var(--muted);font:8.5px var(--body)}
.usage-fact strong{display:block;font:650 13px/1.2 var(--display);overflow-wrap:anywhere}
.provider-cost{border:1px solid var(--line);border-radius:8px;padding:8px 9px;background:color-mix(in srgb,var(--panel-2) 18%,var(--panel))}
.provider-cost strong{display:block;font:600 10.5px var(--body)}
.provider-cost .tiny{margin-top:3px}
.events.section,.section-evidence{display:block}
.section-summary{display:flex;align-items:baseline;justify-content:space-between;gap:10px;cursor:pointer;list-style:none}
.section-summary::-webkit-details-marker{display:none}
.section-summary:after{content:"+";margin-left:auto;color:var(--muted);font:600 15px var(--mono)}
details[open]>.section-summary:after{content:"−"}
.section-title{font:650 13px/1.25 var(--display);letter-spacing:-.01em}
.section-subtitle{color:var(--muted);font:10px/1.35 var(--body);text-align:right}
.evidence-body{padding-top:9px}
.execution-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}
.execution-fact{border:1px solid var(--line);border-radius:8px;padding:9px;min-width:0}
.execution-fact h4{margin:0 0 4px;font:650 10.5px var(--body)}
.execution-fact strong{display:block;font:600 11.5px/1.4 var(--body)}
.fact-detail{margin-top:3px;color:var(--muted);font:9px/1.45 var(--mono);overflow-wrap:anywhere}
.execution-fact .notice{margin-top:6px}
.event-list{max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:7px;margin-top:8px}
.event-row{border-bottom:1px solid var(--line);padding:7px 8px;font-size:10px;overflow-wrap:anywhere}
.event-row:last-child{border-bottom:0}
.event-top{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}
.event-seq{color:var(--muted);font:9px var(--mono)}
.event-type{color:var(--primary);font:700 9px var(--mono)}
.event-summary{margin-top:3px;line-height:1.45}
.event-details summary{color:var(--muted);font:9px var(--mono);margin-top:4px}
.event-details pre{max-height:180px;overflow:auto;margin:4px 0 0;padding:7px;background:var(--code);color:var(--code-ink);font:9px/1.45 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.footer{display:flex;justify-content:space-between;gap:12px;border-top:0;margin-top:16px;padding-top:0;color:var(--muted);font:9px var(--body);letter-spacing:0;text-transform:none}
.toast{position:fixed;right:16px;bottom:16px;z-index:40;max-width:440px;border-radius:7px;background:var(--ink);color:var(--paper);padding:9px 12px;font:11px var(--mono);opacity:0;transform:translateY(8px);transition:.2s;pointer-events:none}
.toast.show{opacity:1;transform:none}
.toast.error{background:var(--bad);color:#fff}
dialog{border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink);padding:0;width:min(920px,calc(100vw - 28px));max-height:calc(100vh - 40px);box-shadow:0 18px 60px rgba(0,0,0,.28)}
dialog::backdrop{background:rgba(0,0,0,.38)}
.dialog-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:11px 13px;border-bottom:1px solid var(--line);background:var(--panel-2)}
.dialog-head h2{margin:0;font:650 13px var(--body);letter-spacing:0;text-transform:none}
.dialog-body{padding:13px;overflow:auto;max-height:calc(100vh - 130px)}
.diag-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}
.diag-card{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:10px;min-width:0}
.diag-card h3{margin:0 0 5px;font:650 11px var(--body)}
.diag-card p{margin:0 0 8px;color:var(--muted);font-size:10.5px;line-height:1.45}
.tag{display:inline-block;border:1px solid color-mix(in srgb,var(--warn) 35%,var(--line));border-radius:999px;background:color-mix(in srgb,var(--warn) 8%,var(--panel));color:var(--warn);padding:2px 6px;font:650 8px var(--body);letter-spacing:.02em;text-transform:none;vertical-align:middle}
.diag-output{border-radius:7px;background:var(--code);color:var(--code-ink);padding:9px;white-space:pre-wrap;overflow-wrap:anywhere;font:9.5px/1.5 var(--mono);max-height:260px;overflow:auto;margin-top:9px}
.diag-actions{display:flex;gap:5px;flex-wrap:wrap}
.checkbox{display:flex;gap:7px;align-items:flex-start;font-size:10.5px;line-height:1.4;margin:7px 0}
@media(max-width:1180px){
  .page-head,.workspace{grid-template-columns:1fr}
  .stats{grid-template-columns:repeat(3,minmax(0,1fr))}
  .task-list{max-height:none}
  .execution-facts{grid-template-columns:1fr}
  .diag-grid{grid-template-columns:1fr}
}
@media(max-width:700px){
  .shell{padding:0 12px 28px}
  .masthead{display:grid;gap:8px;padding:9px 0}
  .top-tools{justify-content:flex-start}
  .brand strong{font-size:15px}
  .experimental-pill{font-size:8px}
  .page-head{padding:18px 0 12px;gap:12px}
  .intro h1{font-size:34px}
  .lede{font-size:12px}
  .stats{grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}
  .filter{min-height:58px;gap:6px;padding:7px}
  .stat-icon{flex-basis:22px;width:22px;height:22px;border-radius:6px}
  .stat-icon svg{width:14px;height:14px}
  .stat-copy>span{font-size:8px}
  .stat-copy strong{font-size:19px}
  .panel-head{padding:8px 10px}
  .panel-title{display:grid;gap:1px}
  .sort-label{display:none}
  .inbox-tools{grid-template-columns:minmax(0,1fr) 106px;padding:8px 10px}
  .task-row{padding:11px 8px 11px 12px}
  .task-row-head{display:grid}
  .task-badges{justify-content:flex-start}
  .task-summary-row{display:grid}
  .detail-body{padding:13px}
  .detail-title{display:grid}
  .hero-chips{justify-content:flex-start}
  .facts{grid-template-columns:1fr 1fr}
  .usage-summary{grid-template-columns:repeat(2,minmax(0,1fr))}
  .usage-columns{grid-template-columns:1fr}
  .form-grid{grid-template-columns:1fr}
  .form-grid .wide{grid-column:auto}
  .section-head{display:block}
  .section-head small{display:block;max-width:none;margin-top:3px;text-align:left}
  .section-summary{display:grid;gap:2px}
  .section-subtitle{text-align:left}
  .footer{display:block}
}
@media(max-width:430px){
  .prefs{gap:5px}
  .prefs select{min-width:76px}
  .task-meta-row{font-size:9px}
  .task-badges .review-chip:not(.blocked){display:none}
  .facts{grid-template-columns:1fr}
}
</style>
</head>
<body>
<div class="shell">
  <header class="masthead">
    <a class="brand" href="/" aria-label="Bridge Task Console">
      <span class="brand-mark"><img class="brand-icon" src="${BRAND_ICON_DATA_URI}" alt="" width="32" height="32"></span>
      <strong data-i18n="brand">Bridge Task Console</strong>
      <span class="experimental-pill" id="experimental-notice">
        <span class="experimental-label" data-i18n="experimental">Experimental</span>
        <span class="visually-hidden" data-i18n="experimentalNotice">Experimental: task status and recovery operations are still being refined.</span>
      </span>
    </a>
    <div class="top-tools">
      <span class="executor"><span class="dot" id="executor-dot"></span><span id="executor-state">CONNECTING</span></span>
      <button class="button quiet" id="diagnostics-open" type="button" data-i18n="diagnostics">Diagnostics</button>
      <div class="prefs">
        <label><span data-i18n="language">Language</span><select id="language"><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
        <label><span data-i18n="theme">Theme</span><select id="theme"><option value="system" data-i18n="themeSystem">System</option><option value="light" data-i18n="themeLight">Light</option><option value="dark" data-i18n="themeDark">Dark</option></select></label>
      </div>
    </div>
  </header>

  <div class="page-head">
    <section class="intro">
      <h1><span data-i18n="titleTasks">Tasks</span></h1>
      <p class="lede" data-i18n="lede">Review task status, results, and recovery actions.</p>
    </section>

    <section class="stats filters" role="group" aria-label="Task filters">
      <button class="filter filter-running" type="button" data-filter="running" aria-pressed="false">
        <span class="stat-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M7 5.2v9.6l7.2-4.8L7 5.2Z"/></svg></span>
        <span class="stat-copy"><span data-i18n="running">Running</span><strong id="count-running">0</strong></span>
      </button>
      <button class="filter filter-attention" type="button" data-filter="attention" aria-pressed="false">
        <span class="stat-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M10 3 2.8 16h14.4L10 3Zm0 3.2 4.5 8.1h-9L10 6.2Zm-.8 2.3v3.3h1.6v-3.3H9.2Zm0 4.2v1.5h1.6v-1.5H9.2Z"/></svg></span>
        <span class="stat-copy"><span data-i18n="attention">Needs attention</span><strong id="count-attention">0</strong></span>
      </button>
      <button class="filter filter-completed" type="button" data-filter="completed" aria-pressed="false">
        <span class="stat-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M10 2.2a7.8 7.8 0 1 0 0 15.6 7.8 7.8 0 0 0 0-15.6Zm3.7 6.1-4.4 4.5-2.8-2.8 1.1-1.1 1.7 1.7 3.3-3.4 1.1 1.1Z"/></svg></span>
        <span class="stat-copy"><span data-i18n="completed">Completed</span><strong id="count-completed">0</strong></span>
      </button>
    </section>
  </div>

  <div id="global-error" class="error" role="alert"></div>

  <div class="workspace">
    <section class="panel inbox-panel">
      <div class="panel-head">
        <div class="panel-title"><h2 data-i18n="taskList">Task inbox</h2><small id="list-meta">--</small></div>
        <div class="list-tools">
          <span class="sort-label" data-i18n="updatedSort">Updated ↓</span>
          <button class="button quiet icon-button" id="refresh-tasks" type="button" data-i18n="refresh">Refresh</button>
        </div>
      </div>
      <div class="inbox-tools">
        <label class="search-box">
          <svg class="search-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M8.6 2.5a6.1 6.1 0 1 0 3.8 10.9l3.2 3.2 1.1-1.1-3.2-3.2A6.1 6.1 0 0 0 8.6 2.5Zm0 1.6a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z"/></svg>
          <input id="task-search" type="search" autocomplete="off" spellcheck="false" placeholder="Search tasks (name or workspace)">
        </label>
        <select id="bucket-filter" class="bucket-filter" aria-label="Task filter">
          <option value="" data-i18n="allTasks">All tasks</option>
          <option value="running" data-i18n="running">Running</option>
          <option value="attention" data-i18n="attention">Needs attention</option>
          <option value="completed" data-i18n="completed">Completed</option>
        </select>
      </div>
      <div id="task-list" class="task-list" aria-live="polite"><div class="empty" data-i18n="loadingTasks">Loading tasks...</div></div>
    </section>

    <section class="panel detail-panel">
      <div class="panel-head"><h2 data-i18n="taskDetails">Task workspace</h2></div>
      <div id="task-detail" class="detail-body"><div class="detail-empty" data-i18n="chooseTask">Select a task to view status, results, and recovery actions.</div></div>
    </section>
  </div>

  <footer class="footer"><span id="footer-count">--</span></footer>
</div>

<dialog id="diagnostics" aria-labelledby="diagnostics-title">
  <div class="dialog-head"><h2 id="diagnostics-title" data-i18n="diagnosticsTitle">Diagnostics and explicit operations</h2><button class="button quiet" id="diagnostics-close" type="button" data-i18n="close">Close</button></div>
  <div class="dialog-body">
    <p class="notice info" data-i18n="diagNotice">Experimental entry points. Opening the page or this dialog performs no model, Runtime-probe or Billing request. Every external read or write below is an explicit click.</p>
    <div class="diag-grid">
      <section class="diag-card">
        <h3><span data-i18n="runtime">Runtime</span> <span class="tag" data-i18n="experimental">Experimental</span></h3>
        <p data-i18n="runtimeHelp">Static installation inspection, authorized zero-model protocol probe, and candidate report export.</p>
        <div class="diag-actions">
          <button class="button secondary" id="diag-runtime-inspect" type="button" data-i18n="inspectRuntime">Inspect</button>
          <button class="button secondary" id="diag-runtime-check" type="button" data-i18n="staticCheck">Static check</button>
          <button class="button secondary" id="diag-runtime-probe" type="button" data-i18n="protocolProbe">Protocol probe</button>
          <button class="button secondary" id="diag-runtime-report" type="button" data-i18n="exportReport">Export report</button>
        </div>
      </section>
      <section class="diag-card">
        <h3><span data-i18n="costLab">Cost Lab</span> <span class="tag" data-i18n="experimental">Experimental</span></h3>
        <p data-i18n="costHelp">Installation environment and historical evidence. A verification entry only loads its explicit confirmation state; it is not started here.</p>
        <div class="diag-actions">
          <button class="button secondary" id="diag-cost-environment" type="button" data-i18n="loadEnvironment">Environment</button>
          <button class="button secondary" id="diag-cost-history" type="button" data-i18n="loadHistory">History</button>
          <button class="button secondary" id="diag-cost-verification" type="button" data-i18n="loadVerification">Verification entry</button>
        </div>
      </section>
      <section class="diag-card">
        <h3><span data-i18n="settings">Settings</span></h3>
        <p data-i18n="autoWakeHelp">Auto Wake defaults on. Turning it off records web_notify/auto_wake_disabled instead of calling the official Queue.</p>
        <label class="checkbox"><input id="auto-wake" type="checkbox"><span data-i18n="autoWake">Auto Wake</span></label>
        <button class="button secondary" id="diag-save-settings" type="button" data-i18n="saveSettings">Save setting</button>
      </section>
    </div>
    <pre id="diag-output" class="diag-output" aria-live="polite"></pre>
  </div>
</dialog>

<div id="toast" class="toast" role="status"></div>
<script>
(function(){
"use strict";
var TEXT={
  en:{
    brand:"Bridge Task Console",language:"Language",theme:"Theme",themeSystem:"System",themeLight:"Light",themeDark:"Dark",
    diagnostics:"Diagnostics",titleTasks:"Tasks",experimental:"Experimental",
    updatedSort:"Updated ↓",allTasks:"All tasks",filterTasks:"Task filter",searchTasks:"Search tasks (name or workspace)",
    experimentalNotice:"Experimental: task status and recovery operations are still being refined.",
    lede:"Review task status, results, and recovery actions.",
    running:"Running",attention:"Needs attention",completed:"Completed",taskList:"Task inbox",refresh:"Refresh",
    colTask:"Task",colWorkspace:"Workspace",colStatus:"Status",colAttempt:"Attempt",colModel:"Model",colPlan:"Plan",colUsage:"Usage",colUpdated:"Updated",colAttention:"Attention",
    loadingTasks:"Loading tasks...",taskDetails:"Task workspace",chooseTask:"Select a task to view status, results, and recovery actions.",
    diagnosticsTitle:"Diagnostics and explicit operations",close:"Close",
    diagNotice:"Experimental entry points. Opening the page or this dialog performs no model, Runtime-probe or Billing request. Every external read or write below is an explicit click.",
    runtime:"Runtime",experimental:"Experimental",runtimeHelp:"Static installation inspection, an authorized zero-model protocol check, and candidate report export.",
    inspectRuntime:"Inspect",staticCheck:"Static check",protocolProbe:"Protocol probe",exportReport:"Export report",
    costLab:"Cost evidence",costHelp:"Installation environment, historical evidence, and the explicit verification entry. Opening this dialog starts no billing request.",
    loadEnvironment:"Environment",loadHistory:"History",loadVerification:"Verification entry",settings:"Settings",
    autoWakeHelp:"Auto Wake defaults on. Turning it off records web_notify/auto_wake_disabled instead of calling the official Queue.",autoWake:"Auto Wake",saveSettings:"Save setting",
    noTasks:"No Task matches this filter.",selectTask:"Select a Task.",task:"Task",workspace:"Workspace",created:"Created",updated:"Updated",objective:"Objective",
    currentAttempt:"Current Attempt",attempt:"Attempt",attemptHistory:"Attempt timeline",historicalReadOnly:"This is a historical Attempt. Actions apply only to the current Attempt.",
    status:"Status",operationPhase:"Operation phase",owner:"Owner",noneObserved:"Not observed",notObserved:"Not observed",notAvailable:"Not available",unknown:"Unknown",dash:"--",
    result:"Result",resultFor:"Result for Attempt {n}",resultMissing:"No Result was observed for this Attempt.",summary:"Summary",issues:"Issues",filesChanged:"Files changed",tests:"Tests",needsMaster:"Needs Master decision",
    attentionHold:"Attention and Hold",hold:"Hold",cleanup:"Cleanup",release:"Release",wake:"Wake",executionUsage:"Execution usage",providerActualCost:"Provider actual cost",masterUsage:"Master usage",events:"Events",
    pendingInteraction:"Pending interaction",replyOutcomeUnknown:"Reply outcome unknown",reply:"Reply",request:"Request",decision:"Decision",reason:"Reason",sendReply:"Send reply",
    replyUnknownWarning:"A previous reply may have reached the Worker. Reconcile before sending anything else; this page will not resend automatically.",
    pendingCount:"{n} pending",nonePending:"No pending request.",
    cleanupPending:"Cleanup is pending.",cleanupUnverified:"Cleanup is unverified. Release is not proven.",cleanupVerified:"Cleanup verified.",cleanupNotRequired:"Cleanup is not required.",cleanupNotStarted:"Cleanup has not started.",
    releaseHeld:"Release is held.",releaseNotReleased:"Not released.",released:"Released",releaseVerified:"Cleanup verified at Release",releaseUnverified:"Released without verified Cleanup",
    wakeSubmissionUnknown:"Queue state needs verification. The page will not resend automatically.",wakeWebNotify:"Web notification only; the official Queue was not opened.",
    notApplicable:"Not applicable",applied:"Applied",notApplied:"Not applied",
    modelObserved:"Observed",modelRequested:"Requested",modelNotObserved:"Not observed",planCoding:"Coding Plan",planStart:"Start Plan",planOther:"Other",planNotObserved:"Not observed",
    execution:"Execution",discount:"Discount",inputTokens:"Input tokens",cachedInput:"Cached input",cacheWrite:"Cache write",outputTokens:"Output tokens",reasoning:"Reasoning",totalTokens:"Total tokens",usageSource:"Usage source",usageScope:"Scope",observedAt:"Observed at",finality:"Finality",conflicts:"Conflicts",
    noUsage:"No runtime Usage was recorded for this Attempt.",noModel:"No effective model was observed.",noPlan:"Plan was not observed.",
    resultStatus:"Result status",errorCode:"Error code",started:"Started",finished:"Finished",
    continue:"Continue",continueHint:"Create the next Attempt from this released Result.",continueFeedback:"Feedback for the next Attempt",continueRequirements:"Additional requirements, one per line",continueSubmit:"Start continuation",
    rework:"Create related rework",reworkHint:"Creates a new Task with the same goal and acceptance boundaries. The original Task, Attempts and results stay intact.",reworkFeedback:"Review feedback for the new Task",reworkSubmit:"Create rework Task",
    cancel:"Request cancel",cancelConfirm:"Request cancellation of the active Attempt? This never forces Release.",cleanupRecovery:"Recover Cleanup",cleanupRecoveryConfirm:"Retry the Cleanup check for this Task? This re-checks the Worker and Cleanup facts, never clears a Hold, and does not bypass the Task state machine.",workerActive:"A Worker or dispatch is active. Continue and related rework stay disabled.",completedNotAccepted:"Completed is not acceptance. Master review is still required.",waitingMaster:"Waiting for Master review. This page does not create an acceptance.",actionUnavailable:"No safe action is available for this Task right now.",actionBlocked:"Blocked by: {reasons}.",
    taskActionDone:"Request accepted.",loadingDetail:"Loading task details...",loadingEvents:"Loading all Events...",eventsComplete:"All Events loaded",eventsFiltered:"Showing Attempt {n}",eventsCount:"{n} Events",eventsEmpty:"No Events were recorded for this Attempt.",
    showDetails:"Details",hideDetails:"Hide details",refreshFailed:"Could not refresh the Task list.",detailFailed:"Could not load this Task.",
    invalidTask:"Invalid Task ID.",sessionOffline:"Executor session is unavailable.",
    holdActive:"Active Hold: {reason}",noHold:"No active Hold.",attentionReasons:"Attention reasons",replyForm:"Reply to permission request",decisionAllow:"Allow",decisionDeny:"Deny",decisionAccept:"Accept",decisionDecline:"Decline",
    taskCount:"{n} Tasks",filteredCount:"Showing {n}",sourceRuntime:"runtime",sourceTaskRequest:"task request",sourceNone:"not observed",sourceProviderKind:"provider kind",sourceSettlement:"per-Attempt settlement",
    settingsLoaded:"Settings loaded.",settingsSaved:"Auto Wake setting saved.",runtimeInspectFailed:"Runtime inspection failed.",costEnvironmentLoaded:"Cost evidence environment loaded.",costHistoryLoaded:"Cost evidence history loaded.",verificationLoaded:"Verification entry loaded. Starting it requires the existing explicit confirmation flow.",reportReady:"Candidate report downloaded.",reportUnavailable:"Candidate report is unavailable.",noHistory:"No historical evidence returned.",diagNoOutput:"Choose an explicit diagnostics operation.",
    resultSubmissionError:"Result submission error",
    overview:"Overview",availableActions:"Available actions",acceptanceAttention:"Acceptance and attention",executionFacts:"Execution facts",
    reviewReady:"Review ready",reviewBlocked:"Review blocked",reviewRequired:"Awaiting review",
    reviewNote:"Completed means the Worker finished; Master acceptance is not recorded here.",
    actionsNote:"Safe next steps for this Task.",
    resultIssues:"Result issues",
    resultIssuesHint:"The Worker reported issues. This is not a Master acceptance decision; review the Result before choosing the next action.",
    resultFailed:"Result failed",
    resultFailedHint:"The Worker Result failed. This is not a Master acceptance decision; inspect the error and choose a safe recovery action.",
    continueSafe:"Continue from this released Result and keep the same Task.",
    reworkSafe:"Create a new Task with the original goal and acceptance boundaries.",
    effort:"Effort",workerUsage:"Worker usage",masterUsageUnavailable:"Master usage is not recorded by this Task.",
    usageNotObserved:"Usage was not observed. This is not zero.",
    noAttentionItems:"No blocking issue is active.",
    executionFactsHint:"Open to inspect Wake, Cleanup and Release evidence.",
    cacheRead:"Cache read",cacheWrite:"Cache write",planLabel:"Plan",executionPhase:"Execution phase",taskId:"Task ID",
    worker:"Worker",master:"Master",wakeNotObserved:"No Wake observed",wakeWebNotifyShort:"Web notification",wakeSubmissionUnknownShort:"Needs verification",
    wakeIntent:"Delivery intent recorded",wakeQueued:"Queued for delivery",wakeTurnStarted:"New Turn started",
    providerCostUnavailable:"No provider settlement was recorded for this Attempt.",
    workerUsageHint:"Tokens recorded for this Attempt.",masterUsageHint:"Master token usage is not available for this Task.",
    showEvidence:"View evidence",hideEvidence:"Hide evidence",
    cleanupIdentityUnverified:"Cleanup could not be verified because the Worker identity could not be confirmed. Nothing was released."
  },
  "zh-CN":{
    brand:"Bridge Task Console",language:"语言",theme:"主题",themeSystem:"跟随系统",themeLight:"浅色",themeDark:"深色",
    diagnostics:"诊断",titleTasks:"任务",experimental:"实验性",
    updatedSort:"更新时间 ↓",allTasks:"全部任务",filterTasks:"任务筛选",searchTasks:"搜索任务（名称或 Workspace）",
    experimentalNotice:"实验性功能：任务状态与恢复操作仍在持续完善。",
    lede:"查看任务状态、结果与可用的恢复操作。",
    running:"进行中",attention:"需处理",completed:"已完成",taskList:"任务收件箱",refresh:"刷新",
    colTask:"任务",colWorkspace:"Workspace",colStatus:"状态",colAttempt:"Attempt",colModel:"模型",colPlan:"套餐",colUsage:"执行消耗",colUpdated:"更新时间",colAttention:"处理",
    loadingTasks:"正在读取任务...",taskDetails:"任务工作台",chooseTask:"选择一个任务，查看状态、结果与恢复操作。",
    diagnosticsTitle:"诊断与显式操作",close:"关闭",
    diagNotice:"实验性入口。打开页面或本对话框不会发出模型、Runtime 探针或 Billing 请求；以下外部读取或写入都必须由你显式点击。",
    runtime:"Runtime",experimental:"实验性",runtimeHelp:"静态安装检查、授权的零模型协议检查与 Candidate Report 导出。",
    inspectRuntime:"检查",staticCheck:"静态检查",protocolProbe:"协议探针",exportReport:"导出报告",
    costLab:"成本证据",costHelp:"安装环境、历史证据与显式验证入口；打开本对话框不会启动 Billing 请求。",
    loadEnvironment:"环境",loadHistory:"历史",loadVerification:"验证入口",settings:"设置",
    autoWakeHelp:"Auto Wake 默认开启。关闭后 Worker 完成只记录 web_notify/auto_wake_disabled，不调用官方 Queue。",autoWake:"Auto Wake",saveSettings:"保存设置",
    noTasks:"没有符合筛选条件的任务。",selectTask:"请选择一个任务。",task:"任务",workspace:"Workspace",created:"创建时间",updated:"更新时间",objective:"目标",
    currentAttempt:"当前 Attempt",attempt:"Attempt",attemptHistory:"Attempt 时间线",historicalReadOnly:"这是历史 Attempt，动作只作用于当前 Attempt。",
    status:"状态",operationPhase:"Operation 阶段",owner:"Owner",noneObserved:"未观测",notObserved:"未观测",notAvailable:"不可用",unknown:"未知",dash:"--",
    result:"Result",resultFor:"Attempt {n} 的 Result",resultMissing:"该 Attempt 未观测到 Result。",summary:"摘要",issues:"问题",filesChanged:"变更文件",tests:"测试",needsMaster:"需要 Master 决策",
    attentionHold:"Attention 与 Hold",hold:"Hold",cleanup:"Cleanup",release:"Release",wake:"Wake",executionUsage:"执行消耗",providerActualCost:"Provider 实际成本",masterUsage:"Master 消耗",events:"Events",
    pendingInteraction:"待处理交互",replyOutcomeUnknown:"回复结果未知",reply:"回复",request:"请求",decision:"决定",reason:"原因",sendReply:"发送回复",
    replyUnknownWarning:"上一次回复可能已到达 Worker。请先对账，不要自动重发；本页面不会自动重发。",
    pendingCount:"{n} 个待处理",nonePending:"没有待处理请求。",
    cleanupPending:"Cleanup 仍在等待。",cleanupUnverified:"Cleanup 未验证，Release 未被证明。",cleanupVerified:"Cleanup 已验证。",cleanupNotRequired:"无需 Cleanup。",cleanupNotStarted:"Cleanup 尚未开始。",
    releaseHeld:"Release 被 Hold 阻止。",releaseNotReleased:"尚未 Release。",released:"已 Release",releaseVerified:"Release 时 Cleanup 已验证",releaseUnverified:"已 Release，但 Cleanup 未验证",
    wakeSubmissionUnknown:"Queue 状态需要核实；页面不会自动重发。",wakeWebNotify:"仅 Web 通知，未打开官方 Queue。",
    notApplicable:"不适用",applied:"已应用",notApplied:"未应用",
    modelObserved:"已观测",modelRequested:"请求值",modelNotObserved:"未观测",planCoding:"Coding Plan",planStart:"Start Plan",planOther:"其他",planNotObserved:"未观测",
    execution:"执行",discount:"优惠",inputTokens:"输入 tokens",cachedInput:"缓存读取",cacheWrite:"缓存写入",outputTokens:"输出 tokens",reasoning:"推理 tokens",totalTokens:"总 tokens",usageSource:"Usage 来源",usageScope:"范围",observedAt:"观测时间",finality:"最终性",conflicts:"冲突",
    noUsage:"该 Attempt 没有运行时 Usage 记录。",noModel:"未观测到实际模型。",noPlan:"未观测到套餐。",
    resultStatus:"Result 状态",errorCode:"错误码",started:"开始",finished:"结束",
    continue:"继续",continueHint:"基于这个已 Release 的 Result 创建下一个 Attempt。",continueFeedback:"给下一个 Attempt 的反馈",continueRequirements:"补充要求，每行一条",continueSubmit:"开始继续",
    rework:"创建关联返工",reworkHint:"会创建一个新 Task，继承原目标与验收边界；原 Task、Attempt 与结果完整保留。",reworkFeedback:"给新 Task 的审查反馈",reworkSubmit:"创建返工 Task",
    cancel:"请求取消",cancelConfirm:"请求取消当前 Attempt？这不会强制 Release。",cleanupRecovery:"恢复 Cleanup",cleanupRecoveryConfirm:"重新核对 Worker 与 Cleanup 事实？此操作不会清除 Hold，也不会绕过任务状态机。",workerActive:"Worker 或派发仍在进行，继续与关联返工保持禁用。",completedNotAccepted:"Completed 不等于验收，仍需 Master 复核。",waitingMaster:"等待 Master 复核。本页面不会伪造验收。",actionUnavailable:"当前任务暂时没有安全可执行的动作。",actionBlocked:"阻塞原因：{reasons}。",
    taskActionDone:"请求已受理。",loadingDetail:"正在读取任务详情...",loadingEvents:"正在加载完整 Events...",eventsComplete:"全部 Events 已加载",eventsFiltered:"仅显示 Attempt {n}",eventsCount:"{n} 条 Events",eventsEmpty:"该 Attempt 没有记录 Events。",
    showDetails:"详情",hideDetails:"收起详情",refreshFailed:"刷新任务列表失败。",detailFailed:"读取该任务失败。",
    invalidTask:"Task ID 无效。",sessionOffline:"Executor 会话不可用。",
    holdActive:"活动 Hold：{reason}",noHold:"没有活动 Hold。",attentionReasons:"需处理原因",replyForm:"回复权限请求",decisionAllow:"允许",decisionDeny:"拒绝",decisionAccept:"接受",decisionDecline:"不接受",
    taskCount:"{n} 个任务",filteredCount:"显示 {n} 个",sourceRuntime:"运行时",sourceTaskRequest:"任务请求",sourceNone:"未观测",sourceProviderKind:"套餐类型",sourceSettlement:"逐 Attempt 结算",
    settingsLoaded:"设置已读取。",settingsSaved:"Auto Wake 设置已保存。",runtimeInspectFailed:"Runtime 检查失败。",costEnvironmentLoaded:"成本证据环境已读取。",costHistoryLoaded:"成本证据历史已读取。",verificationLoaded:"验证入口已读取；启动仍需既有显式确认流程。",reportReady:"Candidate Report 已下载。",reportUnavailable:"Candidate Report 不可用。",noHistory:"没有历史证据。",diagNoOutput:"请选择一个显式诊断操作。",
    resultSubmissionError:"Result 提交错误",
    overview:"概览",availableActions:"可执行操作",acceptanceAttention:"验收与需处理",executionFacts:"执行事实",
    reviewReady:"待验收",reviewBlocked:"验收受阻",reviewRequired:"等待验收",
    reviewNote:"Completed 只表示 Worker 执行结束；本页面没有 Master 验收结论。",
    actionsNote:"该任务当前的安全下一步。",
    resultIssues:"Result 问题",
    resultIssuesHint:"Worker 报告了问题。这不是 Master 验收结论；请先复核 Result 再选择下一步。",
    resultFailed:"Result 失败",
    resultFailedHint:"Worker Result 失败。这不是 Master 验收结论；请检查错误并选择安全的恢复操作。",
    continueSafe:"基于已 Release 的 Result 继续当前任务。",
    reworkSafe:"创建一个继承原目标与验收边界的新 Task。",
    effort:"Effort",workerUsage:"Worker 消耗",masterUsageUnavailable:"该任务没有记录 Master 消耗。",
    usageNotObserved:"未观测到 Usage；这不等于 0。",
    noAttentionItems:"当前没有阻塞性验收问题。",
    executionFactsHint:"展开查看 Wake、Cleanup 与 Release 证据。",
    cacheRead:"缓存读取",cacheWrite:"缓存写入",planLabel:"套餐",executionPhase:"执行阶段",taskId:"Task ID",
    worker:"Worker",master:"Master",wakeNotObserved:"未观测到 Wake",wakeWebNotifyShort:"仅 Web 通知",wakeSubmissionUnknownShort:"需要核实",
    wakeIntent:"已记录投递意图",wakeQueued:"已进入投递队列",wakeTurnStarted:"已开始新 Turn",
    providerCostUnavailable:"该 Attempt 没有记录 Provider 结算金额。",
    workerUsageHint:"该 Attempt 记录的 Token 消耗。",masterUsageHint:"该任务没有记录 Master Token 消耗。",
    showEvidence:"查看证据",hideEvidence:"收起证据",
    cleanupIdentityUnverified:"无法确认 Worker 身份，Cleanup 未能验证；没有执行 Release。"
  }
};
var STATUS={
  en:{queued:"Queued",running:"Running",completed:"Completed",failed:"Failed",cancelled:"Cancelled",waiting_for_master:"Waiting for Master"},
  "zh-CN":{queued:"排队中",running:"执行中",completed:"已完成",failed:"失败",cancelled:"已取消",waiting_for_master:"等待 Master"}
};
var REASON={
  en:{pending_interaction:"Pending interaction",interaction_reply_outcome_unknown:"Reply outcome unknown",cleanup_pending:"Cleanup pending",cleanup_unverified:"Cleanup unverified",waiting_for_master:"Waiting for Master",needs_master_decision:"Needs Master decision",task_failed:"Task failed",worker_active:"Task is still running",wake_submission_unknown:"Queue state needs verification",wake_web_notify:"Web notification",result_submission_failed:"Result submission failed",release_not_completed:"Release is not complete",release_cleanup_unverified:"Release Cleanup is unverified"},
  "zh-CN":{pending_interaction:"待处理交互",interaction_reply_outcome_unknown:"回复结果未知",cleanup_pending:"Cleanup 等待中",cleanup_unverified:"Cleanup 未验证",waiting_for_master:"等待 Master",needs_master_decision:"需要 Master 决策",task_failed:"任务失败",worker_active:"任务仍在运行",wake_submission_unknown:"Queue 状态需要核实",wake_web_notify:"Web 通知",result_submission_failed:"Result 提交失败",release_not_completed:"Release 尚未完成",release_cleanup_unverified:"Release 时 Cleanup 未验证"}
};
var state={lang:"zh-CN",theme:"system",tasks:[],detail:null,detailError:"",listError:"",selected:null,selectedAttempt:null,filter:null,query:"",csrf:"",session:null,events:{taskId:null,rows:[],complete:false,loading:false,error:"",loaded:false},eventsOpen:false,actionForm:null,busy:false,refreshTimer:null,settingsLoaded:false,settings:null,diagOutput:""};
function $(selector){return document.querySelector(selector);}
function el(tag,cls,text){var node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined&&text!==null)node.textContent=String(text);return node;}
function t(key,vars){var table=TEXT[state.lang]||TEXT.en;var value=table[key]||TEXT.en[key]||key;if(vars){Object.keys(vars).forEach(function(name){value=value.split("{"+name+"}").join(String(vars[name]));});}return value;}
function statusLabel(value){var table=STATUS[state.lang]||STATUS.en;return table[value]||value||t("unknown");}
function reasonLabel(value){var table=REASON[state.lang]||REASON.en;if(value&&value.indexOf("hold:")===0)return t("hold")+": "+(table[value.slice(5)]||value.slice(5));return table[value]||value;}
function chip(text,cls){return el("span","status-chip "+(cls||""),text);}
function dash(value){return value===null||value===undefined||value===""?t("dash"):String(value);}
function number(value){return typeof value==="number"&&Number.isFinite(value)?value.toLocaleString(state.lang):t("dash");}
function formatDate(value){if(!value)return t("dash");var date=new Date(value);if(Number.isNaN(date.getTime()))return t("dash");return date.toLocaleString(state.lang);}
function shortId(value){return value?String(value).slice(0,14):t("dash");}
function setError(message){var box=$("#global-error");if(!box)return;box.textContent=message||"";box.classList.toggle("visible",Boolean(message));}
function toast(message,error){var node=$("#toast");if(!node)return;node.textContent=message;node.classList.toggle("error",Boolean(error));node.classList.add("show");clearTimeout(toast._timer);toast._timer=setTimeout(function(){node.classList.remove("show");},3200);}
function errorMessage(error){if(!error)return t("unknown");return error.message||String(error);}
function errorCode(error){return error&&error.code?error.code:"";}
function friendlyError(error){var code=errorCode(error);var message=errorMessage(error);if(code==="CANCEL_FAILED"&&message.indexOf("worker_identity_unverifiable")>=0)return t("cleanupIdentityUnverified");return message;}
async function api(path,options){var opts=options||{};var headers=Object.assign({},opts.headers||{});if(opts.body!==undefined){headers["Content-Type"]="application/json";headers["Content-Length"]=String(new Blob([opts.body]).size);}if(opts.csrf){if(!state.csrf){await loadSession();}headers["X-ZCode-Bridge-CSRF"]=state.csrf;}var response=await fetch(path,{method:opts.method||"GET",headers:headers,body:opts.body});var text=await response.text();var json=null;try{json=text?JSON.parse(text):null;}catch(_ignore){json=null;}if(!response.ok||!json||json.ok===false){var error=new Error((json&&json.error&&json.error.message)||text||("HTTP "+response.status));error.code=json&&json.error&&json.error.code||("HTTP_"+response.status);throw error;}return json.result!==undefined?json.result:(json.data!==undefined?json.data:json);}
function taskIdFromLocation(){try{return new URL(location.href).searchParams.get("task_id");}catch(_ignore){return null;}}
function setTaskInLocation(id){try{var url=new URL(location.href);if(id)url.searchParams.set("task_id",id);else url.searchParams.delete("task_id");history.replaceState(null,"",url.pathname+url.search+url.hash);}catch(_ignore){}}
function applyTheme(){document.documentElement.setAttribute("data-theme",state.theme);try{localStorage.setItem("bridge.ui.theme",state.theme);}catch(_ignore){}}
function applyLanguage(){document.documentElement.setAttribute("lang",state.lang);try{localStorage.setItem("bridge.ui.language",state.lang);}catch(_ignore){}var lang=$("#language");if(lang)lang.value=state.lang;document.querySelectorAll("[data-i18n]").forEach(function(node){node.textContent=t(node.getAttribute("data-i18n"));});var searchBox=$("#task-search");if(searchBox)searchBox.placeholder=t("searchTasks");var bucket=$("#bucket-filter");if(bucket)bucket.setAttribute("aria-label",t("filterTasks"));var notice=$("#experimental-notice");if(notice)notice.title=t("experimentalNotice");document.title=t("brand");renderList();renderDetail();renderFooter();}
function renderFooter(){var footer=$("#footer-count");if(footer)footer.textContent=t("taskCount",{n:state.tasks.length});}
function taskBucket(task){if(task.needs_attention)return "attention";if(task.status==="queued"||task.status==="running")return "running";return "completed";}
function counts(){var result={running:0,attention:0,completed:0};state.tasks.forEach(function(task){result[taskBucket(task)]+=1;});return result;}
function modelText(model){if(!model||model.state==="not_observed")return t("modelNotObserved");return model.model_id||t("dash");}
function modelSourceText(model){if(!model)return t("sourceNone");if(model.state==="observed")return t("modelObserved");if(model.state==="requested")return t("modelRequested");return t("modelNotObserved");}
function planText(plan){if(!plan||plan.kind==="not_observed")return t("planNotObserved");if(plan.kind==="coding_plan")return t("planCoding");if(plan.kind==="start_plan")return t("planStart");return t("planOther");}
function discountText(discount){if(!discount)return t("notObserved");if(discount.state==="applied")return t("applied");if(discount.state==="not_applied")return t("notApplied");if(discount.state==="not_applicable")return t("notApplicable");return t("notObserved");}
function usageText(usage){if(!usage||usage.state!=="observed")return t("notObserved");var parts=[];if(usage.total_tokens!==null&&usage.total_tokens!==undefined)parts.push("total "+number(usage.total_tokens));if(usage.input_tokens!==null&&usage.input_tokens!==undefined)parts.push("in "+number(usage.input_tokens));if(usage.output_tokens!==null&&usage.output_tokens!==undefined)parts.push("out "+number(usage.output_tokens));return parts.length?parts.join(" / "):t("notObserved");}
function cleanupText(cleanup){if(!cleanup||cleanup.state==="not_started")return t("cleanupNotStarted");if(cleanup.state==="not_required")return t("cleanupNotRequired");if(cleanup.state==="pending")return t("cleanupPending");if(cleanup.state==="verified")return t("cleanupVerified");if(cleanup.state==="unverified")return t("cleanupUnverified");return t("unknown");}
function releaseText(release){if(!release||release.state==="not_released")return t("releaseNotReleased");if(release.state==="held")return t("releaseHeld");if(release.state==="released")return t("released");return t("unknown");}
function attentionForAttempt(attempt,status){var reasons=[];if(!attempt)return reasons;if(status==="queued"||status==="running")reasons.push("worker_active");if(attempt.pending_requests&&attempt.pending_requests.length)reasons.push("pending_interaction");if(attempt.reply_outcome_unknown_requests&&attempt.reply_outcome_unknown_requests.length)reasons.push("interaction_reply_outcome_unknown");if(attempt.cleanup&&attempt.cleanup.state==="pending")reasons.push("cleanup_pending");if(attempt.cleanup&&attempt.cleanup.state==="unverified"&&!(attempt.hold&&attempt.hold.active))reasons.push("cleanup_unverified");if(attempt.hold&&attempt.hold.active)reasons.push("hold:"+(attempt.hold.reason_code||"hold"));if(attempt.wake&&attempt.wake.state==="submission_unknown")reasons.push("wake_submission_unknown");if(attempt.wake&&attempt.wake.state==="web_notify")reasons.push("wake_web_notify");if(attempt.result&&attempt.result.needs_master_decision)reasons.push("needs_master_decision");if(status==="waiting_for_master")reasons.push("waiting_for_master");if(status==="failed")reasons.push("task_failed");return reasons;}
function taskTitle(task){return task&&task.name||task&&task.objective||(task&&task.task_id)||t("task");}
function taskMatchesQuery(task,query){if(!query)return true;var hay=[taskTitle(task),task.task_id,task.workspace,task.objective].join(" ").toLowerCase();return hay.indexOf(query)>=0;}
function taskSummaryText(detail,attempt){if(attempt&&attempt.result&&attempt.result.issues&&attempt.result.issues.length)return t("resultIssues");if(attempt&&attempt.result&&(attempt.result.status==="failed"||attempt.result.error_code))return t("resultFailed");if(detail.status==="waiting_for_master")return t("reviewRequired");if(detail.status==="completed")return t("reviewRequired");if(detail.needs_attention&&detail.attention_reasons&&detail.attention_reasons.length)return reasonLabel(detail.attention_reasons[0]);return statusLabel(detail.status);}
function renderList(){renderTaskInbox();}
function renderListLegacy(){var list=$("#task-list");if(!list)return;var current=counts();$("#count-running").textContent=current.running;$("#count-attention").textContent=current.attention;$("#count-completed").textContent=current.completed;document.querySelectorAll(".filter").forEach(function(button){var active=button.getAttribute("data-filter")===state.filter;button.classList.toggle("active",active);button.setAttribute("aria-pressed",active?"true":"false");});var meta=$("#list-meta");if(meta)meta.textContent=state.filter?t("filteredCount",{n:state.tasks.filter(function(task){return taskBucket(task)===state.filter;}).length}):t("taskCount",{n:state.tasks.length});list.replaceChildren();if(state.listError){list.appendChild(el("div","notice bad",state.listError));return;}var visible=state.tasks.filter(function(task){return !state.filter||taskBucket(task)===state.filter;}).sort(function(a,b){return String(b.updated_at||"").localeCompare(String(a.updated_at||""))||String(a.task_id).localeCompare(String(b.task_id));});if(!visible.length){list.appendChild(el("div","empty",t("noTasks")));return;}visible.forEach(function(task){var button=el("button","task-row"+(task.task_id===state.selected?" selected":""));button.type="button";button.setAttribute("data-task-id",task.task_id);button.addEventListener("click",function(){void selectTask(task.task_id,true);});var name=el("span","cell");name.setAttribute("data-label",t("colTask"));name.appendChild(el("span","task-name",taskTitle(task)));name.appendChild(el("span","task-sub",task.task_id));var workspace=el("span","cell");workspace.setAttribute("data-label",t("colWorkspace"));workspace.title=task.workspace||"";workspace.appendChild(el("span","task-workspace",task.workspace||t("notObserved")));var status=el("span","cell");status.setAttribute("data-label",t("colStatus"));status.appendChild(chip(statusLabel(task.status),task.status));var attempt=el("span","cell");attempt.setAttribute("data-label",t("colAttempt"));attempt.appendChild(el("span","mono","#"+String(task.attempt)));var model=el("span","cell");model.setAttribute("data-label",t("colModel"));model.appendChild(el("span","mono",modelText(task.model)));model.appendChild(el("span","tiny",modelSourceText(task.model)));var plan=el("span","cell");plan.setAttribute("data-label",t("colPlan"));plan.appendChild(el("span","mono",planText(task.plan)));var usage=el("span","cell");usage.setAttribute("data-label",t("colUsage"));usage.appendChild(el("span","mono",usageText(task.usage)));usage.appendChild(el("span","tiny",t("discount")+": "+discountText(task.discount)));usage.appendChild(el("span","tiny",t("providerActualCost")+": "+t("notObserved")));var updated=el("span","cell");updated.setAttribute("data-label",t("colUpdated"));updated.appendChild(el("span","tiny",formatDate(task.updated_at)));var attention=el("span","cell");attention.setAttribute("data-label",t("colAttention"));if(task.needs_attention){attention.appendChild(el("span","attention-mark",reasonLabel(task.attention_reasons&&task.attention_reasons[0]||"needs_master_decision")));}else{attention.appendChild(el("span","tiny",t("dash")));}button.appendChild(name);button.appendChild(workspace);button.appendChild(status);button.appendChild(attempt);button.appendChild(model);button.appendChild(plan);button.appendChild(usage);button.appendChild(updated);button.appendChild(attention);list.appendChild(button);});}
function reviewChipFor(task){
  if(!task)return null;
  if(task.status==="waiting_for_master")return el("span","review-chip blocked",t("reviewRequired"));
  if(task.status!=="completed")return null;
  var ready=Boolean(task.action_capabilities&&(task.action_capabilities.can_continue||task.action_capabilities.can_rework));
  return el("span","review-chip"+(ready?"":" blocked"),t(ready?"reviewReady":"reviewBlocked"));
}
function attentionSummary(task){
  var reasons=Array.isArray(task.attention_reasons)?task.attention_reasons:[];
  if(!reasons.length)return "";
  var labels=[];reasons.forEach(function(reason){var label=reasonLabel(reason);if(labels.indexOf(label)<0)labels.push(label);});
  var shown=labels.slice(0,3);
  if(labels.length>3)shown.push("+"+String(labels.length-3));
  return shown.join(" · ");
}
function renderTaskInbox(){
  var list=$("#task-list");
  if(!list)return;
  var current=counts();
  $("#count-running").textContent=current.running;
  $("#count-attention").textContent=current.attention;
  $("#count-completed").textContent=current.completed;
  var bucket=$("#bucket-filter");
  if(bucket)bucket.value=state.filter||"";
  document.querySelectorAll(".filter").forEach(function(button){
    var active=button.getAttribute("data-filter")===state.filter;
    button.classList.toggle("active",active);
    button.setAttribute("aria-pressed",active?"true":"false");
  });
  list.replaceChildren();
  if(state.listError){list.appendChild(el("div","notice bad",state.listError));return;}
  var query=String(state.query||"").trim().toLowerCase();
  var visible=state.tasks.filter(function(task){return (!state.filter||taskBucket(task)===state.filter)&&taskMatchesQuery(task,query);})
    .sort(function(a,b){
      if(Boolean(a.needs_attention)!==Boolean(b.needs_attention))return a.needs_attention?-1:1;
      return String(b.updated_at||"").localeCompare(String(a.updated_at||""))||String(a.task_id).localeCompare(String(b.task_id));
    });
  var meta=$("#list-meta");
  if(meta)meta.textContent=state.filter||query?t("filteredCount",{n:visible.length}):t("taskCount",{n:state.tasks.length});
  if(!visible.length){list.appendChild(el("div","empty",t("noTasks")));return;}
  visible.forEach(function(task){
    var button=el("button","task-row "+taskBucket(task)+" "+task.status+(task.task_id===state.selected?" selected":"")+(task.needs_attention?" attention":""));
    button.type="button";
    button.setAttribute("data-task-id",task.task_id);
    button.setAttribute("aria-label",taskTitle(task)+", "+statusLabel(task.status)+(task.needs_attention?", "+attentionSummary(task):""));
    var main=el("span","task-main");
    var head=el("span","task-row-head");
    var titleWrap=el("span","task-title-wrap");
    titleWrap.appendChild(el("span","task-name",taskTitle(task)));
    titleWrap.appendChild(el("span","task-id",task.task_id));
    var badges=el("span","task-badges");
    badges.appendChild(chip(statusLabel(task.status),task.status));
    var review=reviewChipFor(task);
    if(review)badges.appendChild(review);
    head.appendChild(titleWrap);
    head.appendChild(badges);
    main.appendChild(head);
    var metaRow=el("span","task-meta-row");
    metaRow.appendChild(el("span","task-meta-item",t("attempt")+" #"+String(task.attempt)));
    metaRow.appendChild(el("span","task-meta-item",modelText(task.model)));
    metaRow.appendChild(el("span","task-meta-item",planText(task.plan)));
    metaRow.appendChild(el("span","task-meta-item",formatDate(task.updated_at)));
    main.appendChild(metaRow);
    var workspace=el("span","task-workspace",task.workspace||t("notObserved"));
    workspace.title=task.workspace||"";
    main.appendChild(workspace);
    var summary=el("span","task-summary-row");
    var usageLine=el("span","task-usage-line",t("executionUsage")+": "+usageText(task.usage)+" · "+t("discount")+": "+discountText(task.discount));
    summary.appendChild(usageLine);
    main.appendChild(summary);
    var attentionSummaryText=attentionSummary(task);
    if(attentionSummaryText)main.appendChild(el("span","task-attention",attentionSummaryText));
    button.appendChild(main);
    button.addEventListener("click",function(){void selectTask(task.task_id,true);});
    list.appendChild(button);
  });
}
function effortText(model){
  var effort=model&&model.effort;
  if(!effort||effort.state==="not_observed"||!effort.value)return t("notObserved");
  return effort.value;
}
function effortSourceText(model){
  var effort=model&&model.effort;
  if(!effort||effort.state==="not_observed")return t("sourceNone");
  return effort.state==="observed"?t("modelObserved"):t("modelRequested");
}
function metricText(value){
  return value===null||value===undefined?t("notObserved"):number(value);
}
function detailSection(title,subtitle,key){var section=el("section","section");if(key)section.setAttribute("data-section",key);var head=el("div","section-head");head.appendChild(el("h3","",title));if(subtitle){head.appendChild(el("small","",subtitle));}section.appendChild(head);return section;}
function fact(label,value){var box=el("div","fact");box.appendChild(el("label","",label));box.appendChild(el("strong","",value===null||value===undefined||value===""?t("dash"):String(value)));return box;}
function sectionNote(text,kind){return el("div","notice "+(kind||"info"),text);}
async function loadSession(){try{var session=await api("/api/session");state.csrf=session.csrf_token||"";state.session=session.executor||null;renderExecutor();return session;}catch(error){state.session=null;renderExecutor();throw error;}}
function renderExecutor(){var dot=$("#executor-dot"),label=$("#executor-state");if(!dot||!label)return;var executor=state.session||{};var status=executor.state||"unknown";label.textContent=status.toUpperCase();dot.className="dot"+(status==="active"?" online":status==="unknown"||status==="offline"?" offline":"");}
async function loadTasks(){try{var all=[];var after=null;for(var pageIndex=0;pageIndex<100;pageIndex+=1){var path="/api/tasks?limit=100";if(after)path+="&after_task_id="+encodeURIComponent(after);var page=await api(path);var rows=Array.isArray(page.tasks)?page.tasks:[];rows.forEach(function(task){if(task&&task.task_id)all.push(task);});if(!page.has_more||!page.next_task_id||page.next_task_id===after)break;after=page.next_task_id;}var seen={};state.tasks=all.filter(function(task){if(seen[task.task_id])return false;seen[task.task_id]=true;return true;});state.listError="";}catch(error){state.listError=t("refreshFailed")+" "+errorMessage(error);}renderList();renderFooter();}
async function selectTask(id,updateUrl){if(!id||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(id)){setError(t("invalidTask"));return;}if(state.selected!==id){state.eventsOpen=false;state.events={taskId:null,rows:[],complete:false,loading:false,error:"",loaded:false};state.selectedAttempt=null;state.actionForm=null;}state.selected=id;if(updateUrl)setTaskInLocation(id);renderList();await loadDetail();if(updateUrl&&window.matchMedia&&window.matchMedia("(max-width:1180px)").matches){var panel=document.querySelector(".detail-panel");if(panel&&panel.scrollIntoView)panel.scrollIntoView({behavior:"smooth",block:"start"});}}
async function loadDetail(){var id=state.selected;if(!id)return;try{var detail=await api("/api/tasks/"+encodeURIComponent(id)+"/console");if(state.selected!==id)return;state.detail=detail;state.detailError="";if(state.selectedAttempt===null||!detail.attempts.some(function(attempt){return attempt.attempt===state.selectedAttempt;}))state.selectedAttempt=detail.attempt;renderDetail();}catch(error){if(state.selected!==id)return;state.detail=null;state.detailError=t("detailFailed")+" "+errorMessage(error);renderDetail();}}
function currentAttempt(){if(!state.detail)return null;return state.detail.attempts.find(function(attempt){return attempt.attempt===state.selectedAttempt;})||null;}
function renderDetail(){return renderDetailV2();}
function renderDetailLegacy(){var target=$("#task-detail");if(!target)return;target.replaceChildren();if(!state.selected){target.appendChild(el("div","detail-empty",t("chooseTask")));return;}if(state.detailError){target.appendChild(sectionNote(state.detailError,"bad"));return;}if(!state.detail){target.appendChild(el("div","detail-empty",t("loadingDetail")));return;}var detail=state.detail;var attempt=currentAttempt();if(!attempt){target.appendChild(el("div","detail-empty",t("selectTask")));return;}var hero=el("div","detail-hero");var left=el("div");left.appendChild(el("h2","",detail.task_id));left.appendChild(el("p","",detail.objective||detail.name||""));var chips=el("div","hero-chips");chips.appendChild(chip(statusLabel(detail.status),detail.status));chips.appendChild(chip(t("attempt")+" #"+String(detail.attempt),"info"));if(detail.needs_attention)chips.appendChild(chip(t("attention"),"warn"));hero.appendChild(left);hero.appendChild(chips);target.appendChild(hero);
  var facts=el("div","facts");facts.appendChild(fact(t("workspace"),detail.workspace));facts.appendChild(fact(t("status"),statusLabel(detail.status)));facts.appendChild(fact(t("operationPhase"),attempt.operation_phase||t("notObserved")));facts.appendChild(fact(t("updated"),formatDate(detail.updated_at)));facts.appendChild(fact(t("created"),formatDate(detail.created_at)));facts.appendChild(fact(t("owner"),detail.owner_binding&&detail.owner_binding.owner_thread_id?shortId(detail.owner_binding.owner_thread_id):t("notObserved")));target.appendChild(facts);
  var current=attempt.attempt===detail.attempt;var actions=el("div");target.appendChild(actions);renderActions(actions,detail,attempt,current);if(!current){target.appendChild(sectionNote(t("historicalReadOnly"),"info"));}
  var timeline=detailSection(t("attemptHistory"),t("currentAttempt")+" #"+String(detail.attempt));var attempts=el("div","attempts");detail.attempts.forEach(function(item){var button=el("button","attempt"+(item.attempt===state.selectedAttempt?" active":""));button.type="button";button.setAttribute("aria-pressed",item.attempt===state.selectedAttempt?"true":"false");button.appendChild(el("strong","","Attempt #"+String(item.attempt)+(item.current?" / "+t("currentAttempt"):"")));button.appendChild(el("span","",formatDate(item.updated_at)));button.appendChild(chip(statusLabel(item.status),item.status));button.addEventListener("click",function(){state.selectedAttempt=item.attempt;state.actionForm=null;renderDetail();if(state.eventsOpen)void ensureEvents(false);});attempts.appendChild(button);});timeline.appendChild(attempts);target.appendChild(timeline);
  var result=detailSection(t("resultFor",{n:attempt.attempt}),attempt.result?statusLabel(attempt.result.status):t("notObserved"));if(attempt.result){if(attempt.result.summary)result.appendChild(el("div","result-summary",attempt.result.summary));if(attempt.result.issues&&attempt.result.issues.length){result.appendChild(el("div","tiny",t("issues")));var issueList=el("div","list");attempt.result.issues.forEach(function(issue){issueList.appendChild(el("div","line-item",issue));});result.appendChild(issueList);}if(attempt.result.files_changed&&attempt.result.files_changed.length){result.appendChild(el("div","tiny",t("filesChanged")));var files=el("div","list");attempt.result.files_changed.forEach(function(file){files.appendChild(el("div","line-item",file));});result.appendChild(files);}if(attempt.result.tests&&attempt.result.tests.length){result.appendChild(el("div","tiny",t("tests")));var tests=el("div","list");attempt.result.tests.forEach(function(test){tests.appendChild(el("div","line-item",test.status+"  "+test.command+(test.details?"\n"+test.details:"")));});result.appendChild(tests);}if(attempt.result.needs_master_decision)result.appendChild(sectionNote(t("needsMaster")+" · "+t("waitingMaster"),"warn"));if(attempt.result.error_code)result.appendChild(el("div","tiny",t("errorCode")+": "+attempt.result.error_code));}else{result.appendChild(el("div","muted",t("resultMissing")));}target.appendChild(result);
  var attention=detailSection(t("attentionHold"),t("attentionReasons"));var reasons=attentionForAttempt(attempt,detail.status);if(reasons.length){var reasonWrap=el("div","usage-meta");reasons.forEach(function(reason,index){reasonWrap.appendChild(chip(reasonLabel(reason),index===0&&reason!=="wake_web_notify"?"warn":""));});attention.appendChild(reasonWrap);}else{attention.appendChild(el("div","muted",t("noHold")));}
  if(attempt.hold&&attempt.hold.active)attention.appendChild(sectionNote(t("holdActive",{reason:attempt.hold.reason_code||t("unknown")})+(attempt.hold.at?" · "+formatDate(attempt.hold.at):""),"bad"));
  if(attempt.pending_requests&&attempt.pending_requests.length){attention.appendChild(el("div","tiny",t("pendingInteraction")));var pendingList=el("div","list");attempt.pending_requests.forEach(function(request){pendingList.appendChild(el("div","line-item","request_id: "+request));});attention.appendChild(pendingList);if(current&&detail.action_capabilities.can_reply){attention.appendChild(renderReplyForm(attempt));}}
  if(attempt.reply_outcome_unknown_requests&&attempt.reply_outcome_unknown_requests.length)attention.appendChild(sectionNote(t("replyUnknownWarning"),"bad"));
  if(current&&detail.result_submission_error)attention.appendChild(sectionNote(t("resultSubmissionError")+": "+detail.result_submission_error,"bad"));
  target.appendChild(attention);
  var wake=detailSection(t("wake"),attempt.wake?attempt.wake.state:t("notObserved"));if(attempt.wake){wake.appendChild(el("div","line-item",t("status")+": "+attempt.wake.state+" · "+attempt.wake.reason_code+" · "+formatDate(attempt.wake.at)));if(attempt.wake.state==="submission_unknown")wake.appendChild(sectionNote(t("wakeSubmissionUnknown"),"bad"));if(attempt.wake.state==="web_notify")wake.appendChild(sectionNote(t("wakeWebNotify"),"warn"));}else{wake.appendChild(el("div","muted",t("noneObserved")));}target.appendChild(wake);
  var cleanup=detailSection(t("cleanup"),attempt.cleanup?attempt.cleanup.state:t("notObserved"));cleanup.appendChild(el("div","line-item",cleanupText(attempt.cleanup)));if(attempt.cleanup&&attempt.cleanup.reason_code)cleanup.appendChild(el("div","tiny",attempt.cleanup.reason_code));if(current&&detail.action_capabilities.can_recover_cleanup){var recover=el("button","button secondary",t("cleanupRecovery"));recover.type="button";recover.addEventListener("click",function(){void recoverCleanup();});cleanup.appendChild(recover);}target.appendChild(cleanup);
  var release=detailSection(t("release"),attempt.release?attempt.release.state:t("notObserved"));release.appendChild(el("div","line-item",releaseText(attempt.release)));if(attempt.release&&attempt.release.cleanup_verified!==null)release.appendChild(el("div","tiny",attempt.release.cleanup_verified?t("releaseVerified"):t("releaseUnverified")));if(attempt.release&&attempt.release.reason_code)release.appendChild(el("div","tiny",attempt.release.reason_code));target.appendChild(release);
  var usage=detailSection(t("executionUsage"),t("attempt")+" #"+String(attempt.attempt));usage.appendChild(renderUsageGrid(attempt));target.appendChild(usage);
  var events=detailSection(t("events"),t("eventsFiltered",{n:attempt.attempt}));events.appendChild(renderEventsBlock(attempt));target.appendChild(events);
}
function wakeLabel(value){
  if(!value)return t("wakeNotObserved");
  if(value==="web_notify")return t("wakeWebNotifyShort");
  if(value==="intent")return t("wakeIntent");
  if(value==="queued")return t("wakeQueued");
  if(value==="turn_started")return t("wakeTurnStarted");
  if(value==="submission_unknown")return t("wakeSubmissionUnknownShort");
  return value;
}
function renderDetailV2(){
  var target=$("#task-detail");
  if(!target)return;
  target.replaceChildren();
  if(!state.selected){target.appendChild(el("div","detail-empty",t("chooseTask")));return;}
  if(state.detailError){target.appendChild(sectionNote(state.detailError,"bad"));return;}
  if(!state.detail){target.appendChild(el("div","detail-empty",t("loadingDetail")));return;}
  var detail=state.detail;
  var attempt=currentAttempt();
  if(!attempt){target.appendChild(el("div","detail-empty",t("selectTask")));return;}
  var current=attempt.attempt===detail.attempt;

  var hero=el("div","detail-title");
  var left=el("div","detail-title-main");
  left.appendChild(el("h2","",taskTitle(detail)));
  if(detail.objective&&detail.objective!==taskTitle(detail))left.appendChild(el("p","",detail.objective));
  var context=el("div","detail-context");
  context.appendChild(el("span","mono",detail.task_id));
  context.appendChild(el("span","detail-context-sep","·"));
  context.appendChild(el("span","detail-workspace",detail.workspace||t("notObserved")));
  left.appendChild(context);
  var chips=el("div","hero-chips");
  chips.appendChild(chip(statusLabel(detail.status),detail.status));
  chips.appendChild(chip(t("attempt")+" #"+String(attempt.attempt),"info"));
  var review=reviewChipFor(detail);
  if(review)chips.appendChild(review);
  if(detail.needs_attention)chips.appendChild(chip(t("attention"),"warn"));
  hero.appendChild(left);
  hero.appendChild(chips);
  target.appendChild(hero);

  var overview=detailSection(t("overview"),t("currentAttempt")+" #"+String(detail.attempt),"overview");
  var facts=el("div","facts");
  facts.appendChild(fact(t("workspace"),detail.workspace));
  facts.appendChild(fact(t("executionPhase"),attempt.operation_phase||t("notObserved")));
  facts.appendChild(fact(t("updated"),formatDate(detail.updated_at)));
  facts.appendChild(fact(t("attempt"),"#"+String(attempt.attempt)));
  facts.appendChild(fact(t("owner"),detail.owner_binding&&detail.owner_binding.owner_thread_id?shortId(detail.owner_binding.owner_thread_id):t("notObserved")));
  facts.appendChild(fact(t("summary"),taskSummaryText(detail,attempt)));
  overview.appendChild(facts);
  target.appendChild(overview);

  var actions=detailSection(t("availableActions"),t("actionsNote"),"actions");
  renderActionsV2(actions,detail,attempt,current);
  target.appendChild(actions);

  target.appendChild(renderAcceptanceV2(detail,attempt,current));

  var timeline=detailSection(t("attemptHistory"),t("currentAttempt")+" #"+String(detail.attempt),"attempts");
  var attemptList=el("div","attempts");
  detail.attempts.forEach(function(item){
    var button=el("button","attempt"+(item.attempt===state.selectedAttempt?" active":""));
    button.type="button";
    button.setAttribute("aria-pressed",item.attempt===state.selectedAttempt?"true":"false");
    button.appendChild(el("strong","","Attempt #"+String(item.attempt)+(item.current?" / "+t("currentAttempt"):"")));
    button.appendChild(el("span","",formatDate(item.updated_at)));
    button.appendChild(chip(statusLabel(item.status),item.status));
    button.addEventListener("click",function(){
      state.selectedAttempt=item.attempt;
      state.actionForm=null;
      renderDetail();
      if(state.eventsOpen)void ensureEvents(false);
    });
    attemptList.appendChild(button);
  });
  timeline.appendChild(attemptList);
  target.appendChild(timeline);

  var result=detailSection(t("resultFor",{n:attempt.attempt}),attempt.result?statusLabel(attempt.result.status):t("notObserved"),"result");
  if(attempt.result){
    if(attempt.result.summary)result.appendChild(el("div","result-summary",attempt.result.summary));
    if(attempt.result.issues&&attempt.result.issues.length){
      result.appendChild(el("div","tiny",t("issues")));
      var issueList=el("div","list");
      attempt.result.issues.forEach(function(issue){issueList.appendChild(el("div","line-item",issue));});
      result.appendChild(issueList);
    }
    if(attempt.result.files_changed&&attempt.result.files_changed.length){
      result.appendChild(el("div","tiny",t("filesChanged")));
      var files=el("div","list");
      attempt.result.files_changed.forEach(function(file){files.appendChild(el("div","line-item",file));});
      result.appendChild(files);
    }
    if(attempt.result.tests&&attempt.result.tests.length){
      result.appendChild(el("div","tiny",t("tests")));
      var tests=el("div","list");
      attempt.result.tests.forEach(function(test){tests.appendChild(el("div","line-item",test.status+"  "+test.command+(test.details?"\n"+test.details:"")));});
      result.appendChild(tests);
    }
    if(attempt.result.needs_master_decision)result.appendChild(sectionNote(t("needsMaster")+" · "+t("waitingMaster"),"warn"));
    if(attempt.result.error_code)result.appendChild(el("div","tiny",t("errorCode")+": "+attempt.result.error_code));
  }else{
    result.appendChild(el("div","muted",t("resultMissing")));
  }
  target.appendChild(result);

  var usage=detailSection(t("executionUsage"),t("attempt")+" #"+String(attempt.attempt),"usage");
  usage.appendChild(renderUsageV2(attempt));
  target.appendChild(usage);

  target.appendChild(renderExecutionFactsV2(attempt));
  target.appendChild(renderEventsV2(attempt));
}
function renderActionsV2(section,detail,attempt,current){
  var caps=detail.action_capabilities||{};
  if(!current){
    section.appendChild(el("div","muted",t("historicalReadOnly")));
    return;
  }
  var actions=el("div","detail-actions");
  if(caps.can_continue){
    var continueButton=el("button","button",t("continue"));
    continueButton.type="button";
    continueButton.addEventListener("click",function(){state.actionForm=state.actionForm==="continue"?null:"continue";renderDetail();});
    actions.appendChild(continueButton);
  }
  if(caps.can_rework){
    var reworkButton=el("button","button secondary",t("rework"));
    reworkButton.type="button";
    reworkButton.addEventListener("click",function(){state.actionForm=state.actionForm==="rework"?null:"rework";renderDetail();});
    actions.appendChild(reworkButton);
  }
  if(caps.can_recover_cleanup){
    var recoverButton=el("button","button secondary",t("cleanupRecovery"));
    recoverButton.type="button";
    recoverButton.addEventListener("click",function(){void recoverCleanup();});
    actions.appendChild(recoverButton);
  }
  if(caps.can_reply){
    var replyButton=el("button","button secondary",t("reply"));
    replyButton.type="button";
    replyButton.addEventListener("click",function(){state.actionForm=state.actionForm==="reply"?null:"reply";renderDetail();});
    actions.appendChild(replyButton);
  }
  if(caps.can_cancel){
    var cancelButton=el("button","button danger",t("cancel"));
    cancelButton.type="button";
    cancelButton.addEventListener("click",function(){void cancelTask();});
    actions.appendChild(cancelButton);
  }
  if(!actions.children.length)actions.appendChild(el("div","action-empty",t("actionUnavailable")));
  section.appendChild(actions);
  if(caps.can_continue)section.appendChild(el("div","action-hint",t("continueSafe")));
  else if(caps.can_rework)section.appendChild(el("div","action-hint",t("reworkSafe")));
  if(caps.can_recover_cleanup&&!caps.can_continue&&!caps.can_rework)section.appendChild(el("div","action-hint",t("cleanupUnverified")));
  if((!caps.can_continue&&!caps.can_rework)&&caps.blockers&&caps.blockers.length){
    section.appendChild(sectionNote(t("actionBlocked",{reasons:caps.blockers.map(reasonLabel).join("; ")}),"warn"));
  }
  if(detail.status==="queued"||detail.status==="running")section.appendChild(sectionNote(t("workerActive"),"info"));
  if(state.actionForm==="continue"&&caps.can_continue)section.appendChild(renderContinueForm());
  if(state.actionForm==="rework"&&caps.can_rework)section.appendChild(renderReworkForm());
}
function renderAcceptanceV2(detail,attempt,current){
  var issues=attempt&&attempt.result&&Array.isArray(attempt.result.issues)?attempt.result.issues:[];
  var resultFailed=Boolean(attempt&&attempt.result&&(attempt.result.status==="failed"||attempt.result.error_code));
  var subtitle=resultFailed
    ?t("resultFailedHint")
    :issues.length
      ?t("resultIssuesHint")
      :detail.status==="completed"||detail.status==="waiting_for_master"
        ?t("reviewNote")
        :detail.needs_attention?t("attentionReasons"):"";
  var section=detailSection(t("acceptanceAttention"),subtitle,"acceptance");
  if(resultFailed){
    section.appendChild(sectionNote(t("resultFailed")+(attempt.result.error_code?" · "+attempt.result.error_code:""),"bad"));
  }
  if(issues.length){
    var reported=el("div","notice"+(resultFailed?" bad":""));
    reported.textContent=t("resultIssues")+"\n"+issues.map(function(issue){return "• "+issue;}).join("\n");
    section.appendChild(reported);
  }
  if(detail.status==="completed")section.appendChild(sectionNote(t("completedNotAccepted"),detail.needs_attention?"warn":"info"));
  if(detail.status==="waiting_for_master")section.appendChild(sectionNote(t("waitingMaster"),"warn"));
  var reasons=attentionForAttempt(attempt,detail.status);
  if(reasons.length){
    var reasonWrap=el("div","usage-meta");
    reasons.forEach(function(reason,index){reasonWrap.appendChild(chip(reasonLabel(reason),index===0&&reason!=="wake_web_notify"?"warn":""));});
    section.appendChild(reasonWrap);
  }else if(!(attempt.hold&&attempt.hold.active)&&detail.status!=="completed"&&!issues.length&&!resultFailed){
    section.appendChild(el("div","muted",t("noAttentionItems")));
  }
  if(attempt.hold&&attempt.hold.active){
    section.appendChild(sectionNote(t("holdActive",{reason:attempt.hold.reason_code||t("unknown")})+(attempt.hold.at?" · "+formatDate(attempt.hold.at):""),"bad"));
  }
  if(attempt.pending_requests&&attempt.pending_requests.length){
    section.appendChild(el("div","tiny",t("pendingInteraction")));
    var pendingList=el("div","list");
    attempt.pending_requests.forEach(function(request){pendingList.appendChild(el("div","line-item","request_id: "+request));});
    section.appendChild(pendingList);
  }
  if(current&&detail.action_capabilities&&detail.action_capabilities.can_reply&&state.actionForm==="reply"){
    section.appendChild(renderReplyForm(attempt));
  }
  if(attempt.reply_outcome_unknown_requests&&attempt.reply_outcome_unknown_requests.length){
    section.appendChild(sectionNote(t("replyUnknownWarning"),"bad"));
  }
  if(current&&detail.result_submission_error)section.appendChild(sectionNote(t("resultSubmissionError")+": "+detail.result_submission_error,"bad"));
  return section;
}
function executionFact(title,status,detail,note,kind){
  var box=el("div","execution-fact");
  box.appendChild(el("h4","",title));
  box.appendChild(el("strong","",status));
  if(detail)box.appendChild(el("div","fact-detail",detail));
  if(note)box.appendChild(sectionNote(note,kind||"info"));
  return box;
}
function renderExecutionFactsV2(attempt){
  var details=el("details","section section-evidence");
  details.setAttribute("data-section","execution-facts");
  var summary=el("summary","section-summary");
  summary.appendChild(el("span","section-title",t("executionFacts")));
  summary.appendChild(el("small","section-subtitle",t("executionFactsHint")));
  details.appendChild(summary);
  var body=el("div","evidence-body");
  var grid=el("div","execution-facts");
  if(attempt.wake){
    grid.appendChild(executionFact(
      t("wake"),
      wakeLabel(attempt.wake.state),
      attempt.wake.reason_code+" · "+formatDate(attempt.wake.at),
      attempt.wake.state==="submission_unknown"?t("wakeSubmissionUnknown"):attempt.wake.state==="web_notify"?t("wakeWebNotify"):null,
      attempt.wake.state==="submission_unknown"?"bad":attempt.wake.state==="web_notify"?"warn":"info",
    ));
  }else{
    grid.appendChild(executionFact(t("wake"),t("wakeNotObserved"),"",null,"info"));
  }
  grid.appendChild(executionFact(
    t("cleanup"),
    cleanupText(attempt.cleanup),
    attempt.cleanup&&attempt.cleanup.reason_code?attempt.cleanup.reason_code:"",
    null,
    attempt.cleanup&&attempt.cleanup.state==="unverified"?"warn":"info",
  ));
  grid.appendChild(executionFact(
    t("release"),
    releaseText(attempt.release),
    attempt.release&&attempt.release.reason_code?attempt.release.reason_code:"",
    attempt.release&&attempt.release.cleanup_verified!==null?(attempt.release.cleanup_verified?t("releaseVerified"):t("releaseUnverified")):null,
    attempt.release&&attempt.release.state==="released"&&attempt.release.cleanup_verified===false?"warn":"info",
  ));
  body.appendChild(grid);
  details.appendChild(body);
  return details;
}
function usageFactCell(label,value){
  var cell=el("div","usage-fact");
  cell.appendChild(el("label","",label));
  cell.appendChild(el("strong","",value));
  return cell;
}
function renderUsageV2(attempt){
  var wrap=el("div","usage-board");
  var head=el("div","usage-head");
  var identity=el("div","usage-identity");
  identity.appendChild(el("strong","",modelText(attempt.model)));
  var modelLine=attempt.model&&attempt.model.provider_id?attempt.model.provider_id:"";
  identity.appendChild(el("div","tiny",modelSourceText(attempt.model)+(modelLine?" · "+modelLine:"")));
  identity.appendChild(el("div","tiny",t("effort")+": "+effortText(attempt.model)+" · "+effortSourceText(attempt.model)));
  head.appendChild(identity);
  var tags=el("div","usage-meta");
  tags.appendChild(chip(t("planLabel")+" · "+planText(attempt.plan),attempt.plan&&attempt.plan.kind!=="not_observed"?"info":""));
  tags.appendChild(chip(t("discount")+" · "+discountText(attempt.discount),attempt.discount&&attempt.discount.state==="applied"?"ok":""));
  head.appendChild(tags);
  wrap.appendChild(head);

  var columns=el("div","usage-columns");
  var worker=el("div","usage-column");
  worker.appendChild(el("h4","",t("workerUsage")+" · Attempt #"+String(attempt.attempt)));
  if(attempt.usage&&attempt.usage.state==="observed"){
    var summary=el("div","usage-summary");
    summary.appendChild(usageFactCell(t("totalTokens"),metricText(attempt.usage.total_tokens)));
    summary.appendChild(usageFactCell(t("inputTokens"),metricText(attempt.usage.input_tokens)));
    summary.appendChild(usageFactCell(t("outputTokens"),metricText(attempt.usage.output_tokens)));
    summary.appendChild(usageFactCell(t("cacheRead"),metricText(attempt.usage.cached_input_tokens)));
    summary.appendChild(usageFactCell(t("cacheWrite"),metricText(attempt.usage.cached_write_input_tokens)));
    summary.appendChild(usageFactCell(t("reasoning"),metricText(attempt.usage.reasoning_tokens)));
    worker.appendChild(summary);
    var source=el("div","tiny",t("usageSource")+": "+(attempt.usage.source||t("dash"))+" · "+t("usageScope")+": "+(attempt.usage.scope||t("dash"))+" · "+t("finality")+": "+(attempt.usage.finality||t("dash"))+" · "+t("observedAt")+": "+formatDate(attempt.usage.observed_at));
    worker.appendChild(source);
    if(attempt.usage.conflicts&&attempt.usage.conflicts.length)worker.appendChild(sectionNote(t("conflicts")+": "+attempt.usage.conflicts.join(", "),"warn"));
  }else{
    worker.appendChild(sectionNote(t("usageNotObserved"),"info"));
  }
  var master=el("div","usage-column");
  master.appendChild(el("h4","",t("masterUsage")));
  master.appendChild(el("strong","",t("notObserved")));
  master.appendChild(el("div","tiny",t("masterUsageHint")));
  columns.appendChild(worker);
  columns.appendChild(master);
  wrap.appendChild(columns);

  var cost=el("div","provider-cost");
  cost.appendChild(el("strong","",t("providerActualCost")+": "+t("notObserved")));
  cost.appendChild(el("div","tiny",t("providerCostUnavailable")));
  wrap.appendChild(cost);
  return wrap;
}
function renderEventsV2(attempt){
  var details=el("details","events section section-events");
  details.setAttribute("data-section","events");
  details.open=state.eventsOpen;
  var summary=el("summary","section-summary");
  summary.appendChild(el("span","section-title",t("events")));
  summary.appendChild(el("small","section-subtitle",t("eventsFiltered",{n:attempt.attempt})));
  details.appendChild(summary);
  var body=el("div","evidence-body");
  body.id="events-body";
  body.appendChild(el("div","muted",state.events.loading?t("loadingEvents"):t("eventsEmpty")));
  details.appendChild(body);
  details.addEventListener("toggle",function(){
    state.eventsOpen=details.open;
    if(details.open)void ensureEvents(false);
    else{var current=document.getElementById("events-body");if(current)renderEventsInto(current,attempt);}
  });
  if(state.eventsOpen)void ensureEvents(false);
  return details;
}
function renderActions(section,detail,attempt,current){var caps=detail.action_capabilities||{};if(!current){section.appendChild(el("div","muted",t("historicalReadOnly")));return;}var actions=el("div","detail-actions");if(caps.can_continue){var continueButton=el("button","button",t("continue"));continueButton.type="button";continueButton.addEventListener("click",function(){state.actionForm=state.actionForm==="continue"?null:"continue";renderDetail();});actions.appendChild(continueButton);}if(caps.can_rework){var reworkButton=el("button","button secondary",t("rework"));reworkButton.type="button";reworkButton.addEventListener("click",function(){state.actionForm=state.actionForm==="rework"?null:"rework";renderDetail();});actions.appendChild(reworkButton);}if(caps.can_cancel){var cancelButton=el("button","button danger",t("cancel"));cancelButton.type="button";cancelButton.addEventListener("click",function(){void cancelTask();});actions.appendChild(cancelButton);}if(!actions.children.length)actions.appendChild(el("span","muted",t("actionUnavailable")));section.appendChild(actions);
  if(!caps.can_continue&&!caps.can_rework&&caps.blockers&&caps.blockers.length){section.appendChild(sectionNote(t("actionBlocked",{reasons:caps.blockers.map(reasonLabel).join("; ")}),"warn"));}
  if(detail.status==="queued"||detail.status==="running")section.appendChild(sectionNote(t("workerActive"),"info"));if(detail.status==="completed")section.appendChild(sectionNote(t("completedNotAccepted"),"ok"));if(detail.status==="waiting_for_master")section.appendChild(sectionNote(t("waitingMaster"),"warn"));
  if(state.actionForm==="continue")section.appendChild(renderContinueForm());if(state.actionForm==="rework")section.appendChild(renderReworkForm());
}
function renderContinueForm(){var form=el("form","form-card");form.appendChild(el("div","tiny",t("continueHint")));var feedback=el("label","",t("continueFeedback"));var text=el("textarea");text.name="feedback";text.required=true;feedback.appendChild(text);form.appendChild(feedback);var requirements=el("label","",t("continueRequirements"));var req=el("textarea");req.name="additional_requirements";requirements.appendChild(req);form.appendChild(requirements);var row=el("div","detail-actions");var submit=el("button","button",t("continueSubmit"));submit.type="submit";row.appendChild(submit);form.appendChild(row);form.addEventListener("submit",function(event){event.preventDefault();void continueTask(text.value,req.value);});return form;}
function renderReworkForm(){var form=el("form","form-card");form.appendChild(el("div","tiny",t("reworkHint")));var feedback=el("label","",t("reworkFeedback"));var text=el("textarea");text.name="feedback";text.required=true;feedback.appendChild(text);form.appendChild(feedback);var row=el("div","detail-actions");var submit=el("button","button secondary",t("reworkSubmit"));submit.type="submit";row.appendChild(submit);form.appendChild(row);form.addEventListener("submit",function(event){event.preventDefault();void reworkTask(text.value);});return form;}
function renderReplyForm(attempt){var form=el("form","form-card");form.appendChild(el("div","tiny",t("replyForm")));var grid=el("div","form-grid");var request=el("label","",t("request"));var select=el("select");select.name="request_id";attempt.pending_requests.forEach(function(value){var option=el("option","",value);option.value=value;select.appendChild(option);});request.appendChild(select);grid.appendChild(request);var decision=el("label","",t("decision"));var decisionSelect=el("select");decisionSelect.name="decision";[["allow",t("decisionAllow")],["deny",t("decisionDeny")],["accept",t("decisionAccept")],["decline",t("decisionDecline")]].forEach(function(pair){var option=el("option","",pair[1]);option.value=pair[0];decisionSelect.appendChild(option);});decision.appendChild(decisionSelect);grid.appendChild(decision);var reason=el("label","wide",t("reason"));var reasonInput=el("input");reasonInput.name="reason";reason.appendChild(reasonInput);grid.appendChild(reason);form.appendChild(grid);var row=el("div","detail-actions");var submit=el("button","button",t("sendReply"));submit.type="submit";row.appendChild(submit);form.appendChild(row);form.addEventListener("submit",function(event){event.preventDefault();void replyInteraction(select.value,decisionSelect.value,reasonInput.value);});return form;}
function usageCell(label,value){var cell=el("div","usage-cell");cell.appendChild(el("label","",label));cell.appendChild(el("strong","",value));return cell;}
function renderUsageGrid(attempt){var wrap=el("div");var meta=el("div","usage-meta");meta.appendChild(chip(modelSourceText(attempt.model),attempt.model&&attempt.model.state==="observed"?"ok":""));meta.appendChild(chip(planText(attempt.plan),attempt.plan&&attempt.plan.kind!=="not_observed"?"info":""));meta.appendChild(chip(t("discount")+" · "+discountText(attempt.discount),attempt.discount&&attempt.discount.state==="applied"?"ok":""));wrap.appendChild(meta);if(attempt.model&&attempt.model.state!=="not_observed"){var modelLine=el("div","line-item",(attempt.model.model_id||t("dash"))+"  ·  "+(attempt.model.provider_id||t("dash"))+"  ·  "+modelSourceText(attempt.model));wrap.appendChild(modelLine);}else{wrap.appendChild(el("div","muted",t("noModel")));}
  if(attempt.usage&&attempt.usage.state==="observed"){var grid=el("div","usage-grid");grid.appendChild(usageCell(t("inputTokens"),number(attempt.usage.input_tokens)));grid.appendChild(usageCell(t("cachedInput"),number(attempt.usage.cached_input_tokens)));grid.appendChild(usageCell(t("cacheWrite"),number(attempt.usage.cached_write_input_tokens)));grid.appendChild(usageCell(t("outputTokens"),number(attempt.usage.output_tokens)));grid.appendChild(usageCell(t("reasoning"),number(attempt.usage.reasoning_tokens)));grid.appendChild(usageCell(t("totalTokens"),number(attempt.usage.total_tokens)));wrap.appendChild(grid);var source=el("div","tiny",t("usageSource")+": "+(attempt.usage.source||t("dash"))+" · "+t("usageScope")+": "+(attempt.usage.scope||t("dash"))+" · "+t("finality")+": "+(attempt.usage.finality||t("dash"))+" · "+t("observedAt")+": "+formatDate(attempt.usage.observed_at));wrap.appendChild(source);if(attempt.usage.conflicts&&attempt.usage.conflicts.length)wrap.appendChild(sectionNote(t("conflicts")+": "+attempt.usage.conflicts.join(", "),"warn"));}else{wrap.appendChild(el("div","muted",t("noUsage")));}
  var providerCost=attempt.usage&&attempt.usage.provider_cost;var cost=el("div","line-item provider-cost");cost.appendChild(el("strong","",t("providerActualCost")+": "+t("notObserved")));cost.appendChild(el("span","tiny",providerCost&&providerCost.reason_code?providerCost.reason_code:t("notAvailable")));wrap.appendChild(cost);
  if(state.detail&&state.detail.master_usage){var master=el("div","line-item",t("masterUsage")+": "+t("notObserved")+"  ·  "+(state.detail.master_usage.reason_code||""));wrap.appendChild(master);}return wrap;}
function renderEventsBlock(attempt){var details=el("details","events");details.open=state.eventsOpen;var summary=el("summary","",t("events")+" · "+t("eventsFiltered",{n:attempt.attempt}));details.appendChild(summary);var body=el("div");body.id="events-body";body.appendChild(el("div","muted",state.events.loading?t("loadingEvents"):t("eventsEmpty")));details.appendChild(body);details.addEventListener("toggle",function(){state.eventsOpen=details.open;if(details.open){void ensureEvents(false);}else{var current=document.getElementById("events-body");if(current)renderEventsInto(current,attempt);}});if(state.eventsOpen){void ensureEvents(false);}return details;}
function renderEventsInto(target,attempt){if(!target)return;target.replaceChildren();if(!state.eventsOpen)return;if(state.events.loading){target.appendChild(el("div","muted",t("loadingEvents")));return;}if(state.events.error){target.appendChild(sectionNote(state.events.error,"bad"));return;}var rows=state.events.rows.filter(function(event){return event.attempt===attempt.attempt;}).sort(function(a,b){return Number(a.seq)-Number(b.seq);});var info=el("div","tiny",t("eventsCount",{n:rows.length})+(state.events.complete?" · "+t("eventsComplete"):""));target.appendChild(info);if(!rows.length){target.appendChild(el("div","muted",t("eventsEmpty")));return;}var list=el("div","event-list");rows.forEach(function(event){var row=el("div","event-row");var top=el("div","event-top");top.appendChild(el("span","event-seq","#"+String(event.seq)));top.appendChild(el("span","event-type",event.type||"event"));top.appendChild(el("span","tiny",formatDate(event.at)+(event.attempt?" · Attempt #"+String(event.attempt):"")));row.appendChild(top);row.appendChild(el("div","event-summary",event.summary||""));if(event.details&&Object.keys(event.details).length){var details=el("details","event-details");details.appendChild(el("summary","",t("showDetails")));var pre=el("pre","");pre.textContent=JSON.stringify(event.details,null,2);details.appendChild(pre);row.appendChild(details);}list.appendChild(row);});target.appendChild(list);}
async function ensureEvents(force){var attempt=currentAttempt();if(!state.detail||!attempt)return;if(state.events.taskId!==state.detail.task_id){state.events={taskId:state.detail.task_id,rows:[],complete:false,loading:false,error:"",loaded:false};}if(state.events.loaded&&!force){var mount=document.getElementById("events-body");if(mount)renderEventsInto(mount,attempt);return;}if(state.events.loading)return;state.events.loading=true;state.events.error="";var currentMount=document.getElementById("events-body");if(currentMount)renderEventsInto(currentMount,attempt);var rows=[];var after=0;var complete=false;try{for(var pageIndex=0;pageIndex<500;pageIndex+=1){var path="/api/tasks/"+encodeURIComponent(state.detail.task_id)+"/events?limit=200&include_attempt=true&view=summary&max_bytes=33554432";if(after>0)path+="&after_seq="+String(after);var page=await api(path);if(Array.isArray(page.events))rows=rows.concat(page.events);if(!page.has_more){complete=true;break;}if(!Number.isSafeInteger(page.next_seq)||page.next_seq<=after)break;after=page.next_seq;}state.events.rows=rows;state.events.complete=complete;state.events.loaded=true;}catch(error){state.events.error=errorMessage(error);}finally{state.events.loading=false;}var mountNow=document.getElementById("events-body");if(mountNow&&state.eventsOpen&&state.detail&&state.selected)renderEventsInto(mountNow,currentAttempt()||attempt);}
function canMutate(){return !state.busy&&state.selected&&state.detail;}
async function continueTask(feedback,requirements){if(!canMutate())return;state.busy=true;try{var list=String(requirements||"").split(/\r?\n/u).map(function(value){return value.trim();}).filter(Boolean);await api("/api/tasks/"+encodeURIComponent(state.selected)+"/continue",{method:"POST",csrf:true,body:JSON.stringify({feedback:String(feedback||"").trim(),additional_requirements:list})});state.actionForm=null;state.selectedAttempt=null;toast(t("taskActionDone"));await loadTasks();await loadDetail();}catch(error){toast(errorMessage(error),true);setError(errorMessage(error));}finally{state.busy=false;}}
async function reworkTask(feedback){if(!canMutate())return;state.busy=true;try{await api("/api/tasks/"+encodeURIComponent(state.selected)+"/rework",{method:"POST",csrf:true,body:JSON.stringify({feedback:String(feedback||"").trim()})});state.actionForm=null;state.selectedAttempt=null;toast(t("taskActionDone"));await loadTasks();await loadDetail();}catch(error){toast(errorMessage(error),true);setError(errorMessage(error));}finally{state.busy=false;}}
async function replyInteraction(requestId,decision,reason){if(!canMutate())return;state.busy=true;try{await api("/api/tasks/"+encodeURIComponent(state.selected)+"/reply",{method:"POST",csrf:true,body:JSON.stringify({request_id:requestId,decision:decision,...(reason?{reason:String(reason)}:{})})});state.selectedAttempt=null;toast(t("taskActionDone"));await loadTasks();await loadDetail();if(state.eventsOpen)await ensureEvents(true);}catch(error){toast(errorMessage(error),true);setError(errorMessage(error));}finally{state.busy=false;}}
async function cancelTask(){if(!canMutate())return;if(!window.confirm(t("cancelConfirm")))return;state.busy=true;try{await api("/api/tasks/"+encodeURIComponent(state.selected)+"/cancel",{method:"POST",csrf:true,body:"{}"});state.selectedAttempt=null;toast(t("taskActionDone"));await loadTasks();await loadDetail();if(state.eventsOpen)await ensureEvents(true);}catch(error){toast(errorMessage(error),true);setError(errorMessage(error));}finally{state.busy=false;}}
async function recoverCleanup(){if(!canMutate())return;if(!window.confirm(t("cleanupRecoveryConfirm")))return;state.busy=true;try{await api("/api/tasks/"+encodeURIComponent(state.selected)+"/recover-cleanup",{method:"POST",csrf:true,body:JSON.stringify({release_mode:"zcode_cancel_administrative_release"})});state.selectedAttempt=null;toast(t("taskActionDone"));await loadTasks();await loadDetail();if(state.eventsOpen)await ensureEvents(true);}catch(error){var message=friendlyError(error);toast(message,true);setError(message);}finally{state.busy=false;}}
async function refreshAll(forceEvents){state.busy=true;try{await Promise.all([loadTasks(),state.selected?loadDetail():Promise.resolve()]);if(forceEvents&&state.eventsOpen)await ensureEvents(true);}finally{state.busy=false;}}
function diagOutput(value){state.diagOutput=typeof value==="string"?value:JSON.stringify(value,null,2);var node=$("#diag-output");if(node)node.textContent=state.diagOutput;}
function diagError(error){diagOutput((error&&error.code?error.code+": ":"")+errorMessage(error));toast(errorMessage(error),true);}
async function openDiagnostics(){var dialog=$("#diagnostics");if(!dialog)return;if(!state.settingsLoaded){try{var settings=await api("/api/settings");state.settings=settings;state.settingsLoaded=true;var checkbox=$("#auto-wake");if(checkbox)checkbox.checked=Boolean(settings.auto_wake&&settings.auto_wake.enabled);diagOutput(t("settingsLoaded"));}catch(error){diagError(error);}}if(typeof dialog.showModal==="function")dialog.showModal();else dialog.setAttribute("open","");}
async function saveAutoWake(){try{var checkbox=$("#auto-wake");var result=await api("/api/settings/auto-wake",{method:"POST",csrf:true,body:JSON.stringify({enabled:Boolean(checkbox.checked)})});state.settings=result;state.settingsLoaded=true;diagOutput(t("settingsSaved")+"\n"+JSON.stringify(result,null,2));toast(t("settingsSaved"));}catch(error){diagError(error);}}
async function inspectRuntime(mode){try{var result;if(mode==="check")result=await api("/api/runtime/check",{method:"POST",csrf:true,body:"{}"});else if(mode==="probe")result=await api("/api/runtime/protocol-probe",{method:"POST",csrf:true,body:"{}"});else result=await api("/api/runtime");diagOutput(result);toast(mode==="probe"?t("protocolProbe"):t("inspectRuntime"));}catch(error){diagError(error);}}
async function exportRuntimeReport(){try{var report=await api("/api/runtime/candidate");diagOutput(report);var blob=new Blob([JSON.stringify(report,null,2)+"\n"],{type:"application/json"});var url=URL.createObjectURL(blob);var anchor=document.createElement("a");anchor.href=url;anchor.download="runtime-compatibility-candidate.json";document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(function(){URL.revokeObjectURL(url);},1000);toast(t("reportReady"));}catch(error){diagError(error);}}
async function costDiagnostic(mode){try{var path=mode==="history"?"/api/cost-lab/history":mode==="verification"?"/api/cost-lab/session":"/api/cost-lab/environment";var result=await api(path);diagOutput(result);toast(mode==="history"?t("costHistoryLoaded"):mode==="verification"?t("verificationLoaded"):t("costEnvironmentLoaded"));}catch(error){diagError(error);}}
function bindUi(){
  var language=$("#language");
  var theme=$("#theme");
  language.value=state.lang;
  theme.value=state.theme;
  language.addEventListener("change",function(){state.lang=language.value;applyLanguage();});
  theme.addEventListener("change",function(){state.theme=theme.value;applyTheme();});
  $("#refresh-tasks").addEventListener("click",function(){void refreshAll(false);});
  var search=$("#task-search");
  if(search)search.addEventListener("input",function(){state.query=search.value||"";renderList();});
  var bucket=$("#bucket-filter");
  if(bucket)bucket.addEventListener("change",function(){state.filter=bucket.value||null;renderList();});
  document.querySelectorAll(".filter").forEach(function(button){
    button.addEventListener("click",function(){
      var value=button.getAttribute("data-filter");
      state.filter=state.filter===value?null:value;
      renderList();
    });
  });
  $("#diagnostics-open").addEventListener("click",function(){void openDiagnostics();});
  $("#diagnostics-close").addEventListener("click",function(){var dialog=$("#diagnostics");if(dialog)if(typeof dialog.close==="function")dialog.close();else dialog.removeAttribute("open");});
  $("#diag-save-settings").addEventListener("click",function(){void saveAutoWake();});
  $("#diag-runtime-inspect").addEventListener("click",function(){void inspectRuntime("inspect");});
  $("#diag-runtime-check").addEventListener("click",function(){void inspectRuntime("check");});
  $("#diag-runtime-probe").addEventListener("click",function(){void inspectRuntime("probe");});
  $("#diag-runtime-report").addEventListener("click",function(){void exportRuntimeReport();});
  $("#diag-cost-environment").addEventListener("click",function(){void costDiagnostic("environment");});
  $("#diag-cost-history").addEventListener("click",function(){void costDiagnostic("history");});
  $("#diag-cost-verification").addEventListener("click",function(){void costDiagnostic("verification");});
  var diag=$("#diagnostics");
  if(diag)diag.addEventListener("click",function(event){if(event.target===diag){if(typeof diag.close==="function")diag.close();else diag.removeAttribute("open");}});
  window.addEventListener("popstate",function(){var id=taskIdFromLocation();if(id)void selectTask(id,false);});
  document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible")void refreshAll(false);});
}
async function bootstrap(){try{var savedTheme=localStorage.getItem("bridge.ui.theme");if(savedTheme==="light"||savedTheme==="dark"||savedTheme==="system")state.theme=savedTheme;}catch(_ignore){}try{var savedLang=localStorage.getItem("bridge.ui.language");if(savedLang==="en"||savedLang==="zh-CN")state.lang=savedLang;else if(navigator.language&&navigator.language.indexOf("zh")===0)state.lang="zh-CN";}catch(_ignore){}applyTheme();bindUi();applyLanguage();try{await loadSession();}catch(error){setError(t("sessionOffline")+" "+errorMessage(error));}await loadTasks();var deep=taskIdFromLocation();if(deep){await selectTask(deep,false);}else if(state.tasks.length){var preferred=state.tasks.find(function(task){return task.needs_attention;})||state.tasks[0];await selectTask(preferred.task_id,false);}state.refreshTimer=setInterval(function(){if(document.visibilityState==="visible")void refreshAll(false);},10000);}
document.addEventListener("DOMContentLoaded",function(){void bootstrap();});
})();
</script>
</body>
</html>`;
