/**
 * Single-page Task Console.
 *
 * The page deliberately keeps the product surface small: one task list, one
 * task detail, and one diagnostics entry point.  Every task fact rendered here
 * comes from the existing /api/tasks and /api/tasks/:id/console projections.
 */
export function renderTaskConsoleHtml(brandIconDataUri: string): string {
  return String.raw`<!doctype html>
<html lang="en" data-theme="system">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Bridge Task Console</title>
<style>
:root{
  --bg:#f5f7f4;
  --surface:#ffffff;
  --surface-2:#eef1ed;
  --line:#dfe4df;
  --text:#18211c;
  --text-2:#3d4842;
  --muted:#6c7770;
  --accent:#0f6b5b;
  --primary:#245fc0;
  --ok:#1f704b;
  --warn:#955708;
  --bad:#a72f2a;
  --attention:#fbf4e8;
  --attention-line:#e2c18b;
  --focus:#245fc0;
  --code:#111815;
  --code-ink:#eef3ec;
  --radius:9px;
  --sans:"Aptos","Segoe UI Variable","Segoe UI",sans-serif;
  --display:"Aptos Display","Segoe UI Variable Display","Segoe UI",sans-serif;
  --mono:"Cascadia Code","Consolas",monospace
}
:root[data-theme="dark"]{
  --bg:#0f1512;
  --surface:#161e1a;
  --surface-2:#1d2722;
  --line:#2c3932;
  --text:#e9eee9;
  --text-2:#c3ccc6;
  --muted:#96a39b;
  --accent:#68c8b5;
  --primary:#7aaeff;
  --ok:#7bcaa0;
  --warn:#e0a45d;
  --bad:#ff9188;
  --attention:#211b12;
  --attention-line:#5a4528;
  --focus:#7aaeff;
  --code:#090f0c;
  --code-ink:#eef3ec
}
@media(prefers-color-scheme:dark){:root[data-theme="system"]{
  --bg:#0f1512;--surface:#161e1a;--surface-2:#1d2722;--line:#2c3932;--text:#e9eee9;--text-2:#c3ccc6;
  --muted:#96a39b;--accent:#68c8b5;--primary:#7aaeff;--ok:#7bcaa0;--warn:#e0a45d;--bad:#ff9188;
  --attention:#211b12;--attention-line:#5a4528;--focus:#7aaeff;--code:#090f0c;--code-ink:#eef3ec
}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font:13.5px/1.45 var(--sans)}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
.mono,code,pre{font-family:var(--mono)}
.shell{max-width:1460px;margin:0 auto;padding:0 clamp(14px,2.6vw,32px) 40px}
.masthead{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:58px;border-bottom:1px solid var(--line);padding:9px 0}
.brand{display:flex;align-items:center;gap:9px;min-width:0;color:inherit;text-decoration:none}
.brand-mark{display:grid;place-items:center;flex:0 0 30px;width:30px;height:30px;padding:2px;border:1px solid var(--line);border-radius:7px;background:#fff;overflow:hidden}
.brand-icon{display:block;width:100%;height:100%;object-fit:contain}
.brand strong{display:block;font:650 15px/1.2 var(--display);letter-spacing:-.01em;white-space:nowrap}
.experimental-pill{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;background:var(--surface-2);padding:2px 7px;color:var(--muted);font:600 9px/1.3 var(--sans);letter-spacing:.01em;white-space:nowrap}
.top-tools{display:flex;align-items:center;justify-content:flex-end;gap:7px;flex-wrap:wrap}
.button{border:1px solid var(--line);border-radius:7px;background:var(--surface);color:var(--text);padding:7px 10px;font:600 11.5px/1.2 var(--sans);white-space:nowrap}
.button:hover{border-color:var(--focus);background:color-mix(in srgb,var(--focus) 5%,var(--surface))}
.button.primary{border-color:var(--primary);background:var(--primary);color:#fff}
.button.primary:hover{filter:brightness(.95)}
.button.danger{border-color:var(--bad);background:transparent;color:var(--bad)}
.button.danger:hover{background:color-mix(in srgb,var(--bad) 7%,var(--surface))}
.button:disabled{opacity:.45;cursor:not-allowed}
.icon-button{width:31px;height:31px;padding:0;display:grid;place-items:center;font-size:15px;line-height:1}
.prefs{display:flex;align-items:center;gap:6px}
.prefs select{height:31px;border:1px solid var(--line);border-radius:7px;background:var(--surface);padding:4px 6px;font-size:11px}
#language{min-width:92px}
#theme{min-width:82px}
.page-head{padding:24px 0 14px}
.page-head h1{margin:0;font:640 clamp(28px,4vw,36px)/1 var(--display);letter-spacing:-.035em}
.lede{margin:7px 0 0;color:var(--muted);font:12.5px/1.5 var(--sans)}
.summary-line{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:13px 0 0;color:var(--muted);font:11.5px/1.4 var(--sans)}
.summary-item{display:inline-flex;align-items:baseline;gap:5px;border:0;border-bottom:2px solid transparent;background:transparent;padding:2px 0;color:var(--muted);font:inherit}
.summary-item strong{color:var(--text);font:650 14px/1 var(--display);letter-spacing:-.02em}
.summary-item:hover{color:var(--text)}
.summary-item.active{border-bottom-color:var(--accent);color:var(--text)}
.summary-item[data-filter="attention"] strong{color:var(--warn)}
.summary-item[data-filter="running"] strong{color:var(--primary)}
.summary-item[data-filter="completed"] strong{color:var(--ok)}
.summary-sep{color:var(--line)}
.executor-notice{margin:0 0 12px;border-left:2px solid var(--warn);background:var(--attention);padding:7px 10px;color:var(--text-2);font:11.5px/1.5 var(--sans)}
.executor-notice[hidden]{display:none}
.error{display:none;margin:0 0 12px;border-left:2px solid var(--bad);background:color-mix(in srgb,var(--bad) 6%,var(--surface));padding:8px 10px;color:var(--bad);font-size:11.5px}
.error.visible{display:block}
.workspace{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr);gap:18px;align-items:start}
.panel{min-width:0;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);overflow:hidden}
.list-toolbar{display:grid;grid-template-columns:minmax(0,1fr) 118px 31px;gap:7px;align-items:center;border-bottom:1px solid var(--line);padding:9px 11px}
.search-box{position:relative;display:block;min-width:0}
.search-icon{position:absolute;left:8px;top:50%;width:13px;height:13px;transform:translateY(-50%);fill:var(--muted);pointer-events:none}
.search-box input{width:100%;height:31px;border:1px solid var(--line);border-radius:7px;background:var(--surface);padding:5px 8px 5px 26px;font:11px var(--sans)}
.search-box input::placeholder{color:var(--muted)}
.bucket-filter{width:100%;height:31px;border:1px solid var(--line);border-radius:7px;background:var(--surface);padding:4px 6px;font:11px var(--sans)}
.task-list{max-height:calc(100vh - 278px);min-height:240px;overflow:auto}
.task-row{position:relative;display:block;width:100%;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--text);padding:11px 12px;text-align:left}
.task-row:last-child{border-bottom:0}
.task-row:before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:2px;background:transparent}
.task-row:hover{background:color-mix(in srgb,var(--surface-2) 65%,var(--surface))}
.task-row.selected{background:color-mix(in srgb,var(--accent) 5%,var(--surface))}
.task-row.selected:before{background:var(--accent)}
.task-row.attention{background:color-mix(in srgb,var(--warn) 4%,var(--surface))}
.task-row.attention:before{background:var(--warn)}
.task-main{display:grid;gap:3px;min-width:0}
.task-line{display:flex;align-items:center;gap:7px;min-width:0}
.task-line-title{justify-content:space-between}
.task-name{display:block;flex:1;min-width:0;overflow:hidden;color:var(--text);font:650 13px/1.35 var(--display);text-overflow:ellipsis;white-space:nowrap}
.task-line-meta{display:flex;align-items:center;flex-wrap:wrap;gap:1px 5px;color:var(--muted);font:10px/1.45 var(--sans)}
.task-meta-item{display:inline-flex;min-width:0;white-space:nowrap}
.task-meta-item+.task-meta-item:before{content:"·";margin-right:3px;color:var(--line)}
.task-line-problem{display:flex;align-items:flex-start;gap:5px;color:var(--warn);font:600 10px/1.45 var(--sans)}
.task-line-problem:before{content:"!";display:grid;place-items:center;width:12px;height:12px;flex:0 0 12px;margin-top:1px;border:1px solid currentColor;border-radius:50%;font:700 8px var(--mono)}
.status-chip{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;background:var(--surface-2);color:var(--text-2);padding:2px 6px;font:650 8.5px/1.3 var(--sans);letter-spacing:.01em;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.status-chip.completed,.status-chip.released,.status-chip.ok{background:color-mix(in srgb,var(--ok) 10%,var(--surface));border-color:color-mix(in srgb,var(--ok) 30%,var(--line));color:var(--ok)}
.status-chip.review-pending{background:color-mix(in srgb,var(--accent) 7%,var(--surface));border-color:color-mix(in srgb,var(--accent) 28%,var(--line));color:var(--accent)}
.status-chip.review-blocked,.status-chip.running,.status-chip.waiting_for_master{background:color-mix(in srgb,var(--warn) 9%,var(--surface));border-color:color-mix(in srgb,var(--warn) 30%,var(--line));color:var(--warn)}
.status-chip.failed,.status-chip.cancelled{background:color-mix(in srgb,var(--bad) 8%,var(--surface));border-color:color-mix(in srgb,var(--bad) 28%,var(--line));color:var(--bad)}
.status-chip.queued{background:color-mix(in srgb,var(--primary) 7%,var(--surface));border-color:color-mix(in srgb,var(--primary) 26%,var(--line));color:var(--primary)}
.empty{padding:34px 18px;color:var(--muted);font:12.5px var(--sans);text-align:center}
.detail-panel{min-height:480px}
.detail-body{padding:17px 19px 22px;min-width:0}
.detail-empty{padding:64px 18px;color:var(--muted);font:13px var(--sans);text-align:center}
.task-header{padding:0 0 13px}
.detail-title{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.detail-title-main{min-width:0}
.detail-title h2{margin:0;font:640 20px/1.25 var(--display);letter-spacing:-.02em;overflow-wrap:anywhere}
.detail-title p{margin:4px 0 0;color:var(--text-2);font:12px/1.5 var(--sans);overflow-wrap:anywhere}
.hero-chips{display:flex;align-items:center;justify-content:flex-end;gap:4px;flex:0 0 auto;flex-wrap:wrap}
.detail-context{display:flex;align-items:center;flex-wrap:wrap;gap:2px 6px;margin-top:6px;color:var(--muted);font:10px/1.45 var(--mono);min-width:0}
.detail-context-sep{color:var(--line)}
.detail-path{display:flex;align-items:baseline;gap:6px;margin-top:5px;min-width:0;color:var(--muted);font:9.5px/1.45 var(--mono)}
.detail-path-label{flex:0 0 auto;color:var(--muted);font:9px var(--sans)}
.detail-path code{min-width:0;overflow-wrap:anywhere}
.region{border-top:1px solid var(--line);margin-top:15px;padding-top:14px;min-width:0}
.region:first-of-type{border-top:0;margin-top:0;padding-top:0}
.region-title{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:0 0 8px}
.region-title h3{margin:0;color:var(--muted);font:650 10px/1.3 var(--sans);letter-spacing:.09em;text-transform:uppercase}
.region-title small{color:var(--muted);font:9.5px/1.35 var(--sans);text-align:right}
.problem{display:grid;gap:5px;border-left:2px solid var(--line);padding:1px 0 1px 9px}
.problem.bad{border-color:var(--bad)}
.problem.warn{border-color:var(--warn)}
.problem.info{border-color:var(--line)}
.problem.ok{border-color:var(--line)}
.problem-line{margin:0;color:var(--text-2);font:11.5px/1.55 var(--sans);overflow-wrap:anywhere}
.problem-line strong{margin-right:0;color:var(--text);font-weight:650}
.problem-sep{color:var(--muted)}
.problem.bad .problem-line strong{color:var(--bad)}
.problem.warn .problem-line strong{color:var(--warn)}
.problem.ok .problem-line strong{color:var(--muted)}
.actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:9px}
.action-note{margin:6px 0 0;color:var(--muted);font:10.5px/1.45 var(--sans)}
.action-note.blocked{color:var(--warn)}
.form-card{border:1px solid var(--line);border-radius:7px;background:color-mix(in srgb,var(--surface-2) 35%,var(--surface));padding:9px;margin:9px 0 0}
.form-card label{display:grid;gap:4px;margin-bottom:7px;color:var(--muted);font:9.5px var(--sans)}
.form-card textarea,.form-card input,.form-card select{width:100%;min-height:31px;border:1px solid var(--line);border-radius:6px;background:var(--surface);padding:6px 7px;font-size:11px}
.form-card textarea{min-height:66px;resize:vertical}
.form-grid{display:grid;grid-template-columns:1fr 112px;gap:7px}
.form-grid .wide{grid-column:1/-1}
.attempts{display:flex;gap:6px;overflow:auto;padding:1px 0 4px}
.attempt{min-width:118px;border:1px solid var(--line);border-radius:7px;background:var(--surface);padding:7px 8px;text-align:left;color:var(--text)}
.attempt:hover{border-color:var(--focus)}
.attempt.active{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 5%,var(--surface))}
.attempt strong{display:block;font:650 10.5px var(--sans)}
.attempt span{display:block;margin-top:2px;overflow:hidden;color:var(--muted);font:8.5px var(--mono);text-overflow:ellipsis;white-space:nowrap}
.attempt .status-chip{margin-top:4px}
.result-block{margin-top:8px}
.result-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.result-head h4{margin:0;color:var(--text-2);font:600 11px var(--sans)}
.result-semantics{margin:4px 0 0;color:var(--muted);font:10px/1.45 var(--sans)}
.result-summary{margin:7px 0 0;font:12px/1.6 var(--sans);white-space:pre-wrap;overflow-wrap:anywhere}
.result-metrics{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:6px;color:var(--muted);font:10px/1.45 var(--sans)}
.result-metrics span+span:before{content:"·";margin-right:5px;color:var(--line)}
.result-details{margin-top:7px}
.result-details>summary{cursor:pointer;color:var(--muted);font:10px var(--sans);list-style:none}
.result-details>summary::-webkit-details-marker{display:none}
.result-details>summary:before{content:"+";display:inline-block;width:11px;color:var(--muted);font:600 12px var(--mono)}
.result-details[open]>summary:before{content:"−"}
.result-detail-body{display:grid;gap:6px;margin-top:6px}
.detail-label{margin:0;color:var(--muted);font:9px/1.3 var(--sans);letter-spacing:.04em;text-transform:uppercase}
.detail-list{display:grid;gap:2px;margin:0;padding:0;list-style:none}
.detail-list li{padding:3px 0;border-bottom:1px solid color-mix(in srgb,var(--line) 65%,transparent);font:10.5px/1.45 var(--mono);overflow-wrap:anywhere}
.detail-list li:last-child{border-bottom:0}
.detail-list .test-row{font-family:var(--sans)}
.test-failed{color:var(--bad)}
.test-not-run{color:var(--warn)}
.execution-region>summary,.technical-region>summary{display:flex;align-items:baseline;justify-content:space-between;gap:10px;cursor:pointer;list-style:none;min-width:0}
.execution-region>summary::-webkit-details-marker,.technical-region>summary::-webkit-details-marker{display:none}
.execution-region>summary:after,.technical-region>summary:after{content:"+";flex:0 0 auto;color:var(--muted);font:600 13px var(--mono)}
.execution-region[open]>summary:after,.technical-region[open]>summary:after{content:"−"}
.execution-title{flex:0 0 auto;color:var(--muted);font:650 10px/1.3 var(--sans);letter-spacing:.09em;text-transform:uppercase}
.execution-line{display:flex;align-items:baseline;justify-content:flex-end;gap:5px;flex-wrap:wrap;min-width:0;color:var(--text-2);font:10.5px/1.45 var(--sans);text-align:right}
.execution-sep{color:var(--line)}
.execution-body{margin-top:10px}
.exec-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px 14px}
.exec-cell{min-width:0}
.exec-cell label,.usage-fact label{display:block;margin-bottom:2px;color:var(--muted);font:9px var(--sans)}
.exec-cell strong,.usage-fact strong{display:block;font:600 11.5px/1.4 var(--sans);overflow-wrap:anywhere}
.usage-fact strong{font:650 13px/1.25 var(--display)}
.provider-cost{margin-top:10px;padding-top:8px;border-top:1px solid color-mix(in srgb,var(--line) 65%,transparent)}
.provider-cost strong{display:block;font:600 11px var(--sans)}
.provider-cost small{display:block;margin-top:2px;color:var(--muted);font:9.5px/1.45 var(--sans)}
.usage-scope{display:grid;gap:1px;margin-top:8px;color:var(--text-2);font:10.5px/1.45 var(--sans)}
.usage-scope b{font-weight:650}
.usage-scope small{color:var(--muted);font:9.5px/1.4 var(--sans)}
.usage-observed{color:var(--text)}
.tech-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px 14px;margin-top:10px}
.tech-item{min-width:0}
.tech-item h4{margin:0 0 3px;color:var(--muted);font:9px var(--sans);letter-spacing:.04em;text-transform:uppercase}
.tech-item strong{display:block;font:600 11px/1.4 var(--sans);overflow-wrap:anywhere}
.tech-item small{display:block;margin-top:2px;color:var(--muted);font:9px/1.45 var(--mono);overflow-wrap:anywhere}
.tech-note{margin:5px 0 0;border-left:2px solid var(--warn);padding-left:7px;color:var(--warn);font:10px/1.45 var(--sans)}
.events{margin-top:12px;padding-top:9px;border-top:1px solid color-mix(in srgb,var(--line) 65%,transparent)}
.events>summary{cursor:pointer;color:var(--muted);font:600 10px var(--sans);list-style:none}
.events>summary::-webkit-details-marker{display:none}
.events>summary:after{content:"+";margin-left:5px;font:600 12px var(--mono)}
.events[open]>summary:after{content:"−"}
.event-list{max-height:380px;overflow:auto;margin-top:7px;border-top:1px solid color-mix(in srgb,var(--line) 65%,transparent)}
.event-row{border-bottom:1px solid color-mix(in srgb,var(--line) 65%,transparent);padding:6px 1px;font-size:10px;overflow-wrap:anywhere}
.event-top{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.event-seq{color:var(--muted);font:9px var(--mono)}
.event-type{color:var(--primary);font:700 9px var(--mono)}
.event-summary{margin-top:2px;line-height:1.45}
.event-details summary{color:var(--muted);font:9px var(--mono);margin-top:3px}
.event-details pre{max-height:160px;overflow:auto;margin:4px 0 0;padding:7px;background:var(--code);color:var(--code-ink);font:9px/1.45 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.toast{position:fixed;right:16px;bottom:16px;z-index:40;max-width:440px;border-radius:7px;background:var(--text);color:var(--bg);padding:8px 11px;font:10.5px var(--mono);opacity:0;transform:translateY(8px);transition:.2s;pointer-events:none}
.toast.show{opacity:1;transform:none}
.toast.error{background:var(--bad);color:#fff}
dialog{border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--text);padding:0;width:min(900px,calc(100vw - 28px));max-height:calc(100vh - 40px)}
dialog::backdrop{background:rgba(0,0,0,.38)}
.dialog-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 12px;border-bottom:1px solid var(--line);background:var(--surface-2)}
.dialog-head h2{margin:0;font:650 12px var(--sans)}
.dialog-body{padding:12px;overflow:auto;max-height:calc(100vh - 120px)}
.diag-notice{margin:0 0 10px;color:var(--muted);font:10.5px/1.5 var(--sans)}
.diag-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}
.diag-card{border:1px solid var(--line);border-radius:8px;background:var(--surface);padding:10px;min-width:0}
.diag-card h3{margin:0 0 5px;font:650 11px var(--sans)}
.diag-card p{margin:0 0 7px;color:var(--muted);font-size:10px;line-height:1.45}
.diag-actions{display:flex;gap:5px;flex-wrap:wrap}
.tag{display:inline-block;border:1px solid color-mix(in srgb,var(--warn) 32%,var(--line));border-radius:999px;background:color-mix(in srgb,var(--warn) 7%,var(--surface));color:var(--warn);padding:1px 5px;font:650 8px var(--sans);vertical-align:middle}
.diag-output{border-radius:7px;background:var(--code);color:var(--code-ink);padding:8px;white-space:pre-wrap;overflow-wrap:anywhere;font:9.5px/1.5 var(--mono);max-height:240px;overflow:auto;margin-top:9px}
.checkbox{display:flex;gap:6px;align-items:flex-start;font-size:10px;line-height:1.4;margin:6px 0}
@media(max-width:980px){
  .workspace{grid-template-columns:1fr}
  .task-list{max-height:44vh}
  .exec-grid,.tech-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .diag-grid{grid-template-columns:1fr}
}
@media(max-width:700px){
  .shell{padding:0 12px 28px}
  .masthead{display:grid;gap:7px;padding:9px 0}
  .top-tools{justify-content:flex-start}
  .page-head{padding:18px 0 12px}
  .page-head h1{font-size:30px}
  .lede{font-size:12px}
  .summary-line{gap:5px}
  .list-toolbar{grid-template-columns:minmax(0,1fr) 108px 31px;padding:8px 9px}
  .task-row{padding:10px 10px 10px 11px}
  .task-line-meta{font-size:9.5px}
  .detail-body{padding:13px 13px 20px}
  .detail-title{display:grid;gap:7px}
  .hero-chips{justify-content:flex-start}
  .exec-grid,.tech-grid{grid-template-columns:1fr}
  .execution-region>summary,.technical-region>summary{display:grid;gap:3px}
  .execution-line{justify-content:flex-start;text-align:left}
  .form-grid{grid-template-columns:1fr}
  .form-grid .wide{grid-column:auto}
  .attempts{flex-wrap:wrap;overflow:visible}
  .attempt{min-width:calc(50% - 3px);flex:1 1 calc(50% - 3px)}
}
@media(max-width:430px){
  .prefs{gap:5px}
  #language{min-width:86px}
  #theme{min-width:76px}
  .task-line-meta{font-size:9px}
  .result-metrics{display:grid;gap:1px}
  .result-metrics span+span:before{display:none}
}
</style>
</head>
<body>
<div class="shell">
  <header class="masthead">
    <a class="brand" href="/" aria-label="Bridge Task Console">
      <span class="brand-mark"><img class="brand-icon" src="${brandIconDataUri}" alt="" width="30" height="30"></span>
      <strong data-i18n="brand">Bridge Task Console</strong>
      <span class="experimental-pill" id="experimental-notice">
        <span class="experimental-label" data-i18n="experimental">Experimental</span>
        <span class="visually-hidden" data-i18n="experimentalNotice">Experimental: task status and recovery operations are still being refined.</span>
      </span>
    </a>
    <div class="top-tools">
      <button class="button" id="diagnostics-open" type="button" data-i18n="diagnostics">Diagnostics</button>
      <div class="prefs">
        <label><span class="visually-hidden" data-i18n="language">Language</span><select id="language" aria-label="Language"><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
        <label><span class="visually-hidden" data-i18n="theme">Theme</span><select id="theme" aria-label="Theme"><option value="system" data-i18n="themeSystem">System</option><option value="light" data-i18n="themeLight">Light</option><option value="dark" data-i18n="themeDark">Dark</option></select></label>
      </div>
    </div>
  </header>

  <div class="page-head">
    <h1 data-i18n="titleTasks">Tasks</h1>
    <p class="lede" data-i18n="lede">Review task status, results, and recovery actions.</p>
    <div class="summary-line" role="group" aria-label="Task filters">
      <button class="summary-item" type="button" data-filter="running" aria-pressed="false"><span data-i18n="running">Running</span><strong id="count-running">0</strong></button>
      <span class="summary-sep" aria-hidden="true">·</span>
      <button class="summary-item" type="button" data-filter="attention" aria-pressed="false"><span data-i18n="attention">Needs attention</span><strong id="count-attention">0</strong></button>
      <span class="summary-sep" aria-hidden="true">·</span>
      <button class="summary-item" type="button" data-filter="completed" aria-pressed="false"><span data-i18n="completed">Completed</span><strong id="count-completed">0</strong></button>
    </div>
  </div>

  <div id="executor-notice" class="executor-notice" hidden></div>
  <div id="global-error" class="error" role="alert"></div>

  <div class="workspace">
    <section class="panel list-panel">
      <div class="list-toolbar">
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
        <button class="button icon-button" id="refresh-tasks" type="button" title="Refresh" aria-label="Refresh">↻</button>
      </div>
      <div id="task-list" class="task-list" aria-live="polite"><div class="empty" data-i18n="loadingTasks">Loading tasks...</div></div>
    </section>

    <section class="panel detail-panel">
      <div id="task-detail" class="detail-body"><div class="detail-empty" data-i18n="chooseTask">Select a task to review its status, result, and next action.</div></div>
    </section>
  </div>
</div>

<dialog id="diagnostics" aria-labelledby="diagnostics-title">
  <div class="dialog-head"><h2 id="diagnostics-title" data-i18n="diagnosticsTitle">Diagnostics and explicit operations</h2><button class="button" id="diagnostics-close" type="button" data-i18n="close">Close</button></div>
  <div class="dialog-body">
    <p class="diag-notice" data-i18n="diagNotice">Experimental entry points. Opening this dialog performs no model, Runtime-probe or Billing request; every external read or write below is an explicit click.</p>
    <div class="diag-grid">
      <section class="diag-card">
        <h3><span data-i18n="runtime">Runtime</span> <span class="tag" data-i18n="experimental">Experimental</span></h3>
        <p data-i18n="runtimeHelp">Static installation inspection, authorized zero-model protocol probe, and candidate report export.</p>
        <div class="diag-actions">
          <button class="button" id="diag-runtime-inspect" type="button" data-i18n="inspectRuntime">Inspect</button>
          <button class="button" id="diag-runtime-check" type="button" data-i18n="staticCheck">Static check</button>
          <button class="button" id="diag-runtime-probe" type="button" data-i18n="protocolProbe">Protocol probe</button>
          <button class="button" id="diag-runtime-report" type="button" data-i18n="exportReport">Export report</button>
        </div>
      </section>
      <section class="diag-card">
        <h3><span data-i18n="costLab">Cost evidence</span> <span class="tag" data-i18n="experimental">Experimental</span></h3>
        <p data-i18n="costHelp">Installation environment and historical evidence. A verification entry only loads its explicit confirmation state; it is not started here.</p>
        <div class="diag-actions">
          <button class="button" id="diag-cost-environment" type="button" data-i18n="loadEnvironment">Environment</button>
          <button class="button" id="diag-cost-history" type="button" data-i18n="loadHistory">History</button>
          <button class="button" id="diag-cost-verification" type="button" data-i18n="loadVerification">Verification entry</button>
        </div>
      </section>
      <section class="diag-card">
        <h3><span data-i18n="settings">Settings</span></h3>
        <p data-i18n="autoWakeHelp">Auto Wake defaults on. Turning it off records web_notify/auto_wake_disabled instead of calling the official Queue.</p>
        <label class="checkbox"><input id="auto-wake" type="checkbox"><span data-i18n="autoWake">Auto Wake</span></label>
        <button class="button" id="diag-save-settings" type="button" data-i18n="saveSettings">Save setting</button>
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
    experimentalNotice:"Experimental: task status and recovery operations are still being refined.",
    lede:"Review task status, results, and recovery actions.",
    running:"Running",attention:"Needs attention",completed:"Completed",waitingMasterShort:"Waiting for Master",
    searchTasks:"Search tasks (name or workspace)",filterTasks:"Task filter",allTasks:"All tasks",refresh:"Refresh",
    loadingTasks:"Loading tasks...",noTasks:"No Task matches this filter.",chooseTask:"Select a task to review its status, result, and next action.",
    refreshFailed:"Could not refresh the Task list.",detailFailed:"Could not load this Task.",invalidTask:"Invalid Task ID.",sessionOffline:"Executor session is unavailable.",
    completedReviewPending:"Completed · Awaiting review",completedReviewBlocked:"Completed · Review blocked",
    problemActions:"Problem and actions",workHistory:"Work history",execution:"Execution",technicalDetails:"Technical details",
    technicalHint:"Wake · Cleanup · Release · Events",
    completedNotAccepted:"Completed is not acceptance. Master review is still required.",
    review:"Review",current:"Current",usageSummaryNotObserved:"Usage not observed",modelPlanNotObserved:"Model and plan not observed",
    waitingMaster:"Waiting for Master review. This page does not create an acceptance.",
    workerActive:"A Worker or dispatch is active. Continue and related rework stay disabled.",
    resultFailed:"Result failed",resultFailedHint:"The Worker Result failed. This is not a Master acceptance decision; inspect the error and choose a safe recovery action.",
    resultIssues:"Result issues",resultIssuesHint:"The Worker reported issues. This is not a Master acceptance decision; review the Result before choosing the next action.",
    cleanup:"Cleanup",cleanupPending:"Cleanup is pending.",cleanupUnverified:"Cleanup is unverified. Release is not proven.",cleanupVerified:"Cleanup verified.",cleanupNotRequired:"Cleanup is not required.",cleanupNotStarted:"Cleanup has not started.",cleanupPendingShort:"Pending.",cleanupUnverifiedShort:"Unverified. Release is not proven.",
    wake:"Wake",wakeSubmissionUnknown:"Queue state needs verification. The page will not resend automatically.",wakeWebNotify:"Web notification only; the official Queue was not opened.",
    hold:"Hold",holdActive:"Active Hold: {reason}",noAttentionItems:"No blocking issue is active.",
    pendingInteraction:"Pending interaction",replyUnknownWarning:"A previous reply may have reached the Worker. Reconcile before sending anything else; this page will not resend automatically.",
    needsMaster:"Needs Master decision",resultSubmissionError:"Result submission error",
    resultFor:"Result for Attempt {n}",resultMissing:"No Result was observed for this Attempt.",resultDetails:"Result details",
    issues:"Issues",filesChanged:"Files changed",tests:"Tests",started:"Started",finished:"Finished",
    workerCompleted:"Worker completed. Master acceptance is not recorded.",workerFailed:"Worker failed. Master acceptance is not recorded.",
    workerCancelled:"Worker execution was cancelled.",masterReviewPending:"Worker completed. Master review is pending.",
    masterAcceptanceNotRecorded:"Master acceptance is not recorded by this Task.",masterAccepted:"Master accepted.",
    continue:"Continue",continueHint:"Create the next Attempt from this released Result.",continueFeedback:"Feedback for the next Attempt",continueRequirements:"Additional requirements, one per line",continueSubmit:"Start continuation",
    rework:"Create related rework",reworkHint:"Creates a new Task with the same goal and acceptance boundaries. The original Task, Attempts and results stay intact.",reworkFeedback:"Review feedback for the new Task",reworkSubmit:"Create rework Task",
    reply:"Reply",replyForm:"Reply to permission request",request:"Request",decision:"Decision",reason:"Reason",sendReply:"Send reply",
    decisionAllow:"Allow",decisionDeny:"Deny",decisionAccept:"Accept",decisionDecline:"Decline",
    cancel:"Request cancel",cancelConfirm:"Request cancellation of the active Attempt? This never forces Release.",
    cleanupRecovery:"Recover Cleanup",cleanupRecoveryConfirm:"Retry the Cleanup check for this Task? This re-checks the Worker and Cleanup facts, never clears a Hold, and does not bypass the Task state machine.",
    actionUnavailable:"No safe action is available for this Task right now.",actionBlocked:"Blocked by: {reasons}.",
    continueSafe:"Continue is safe for this released Result.",reworkSafe:"Create a related rework Task with the same goal and acceptance boundaries.",
    cleanupNeedsVerification:"Cleanup must be verified before this Task can be continued or reworked.",
    historicalReadOnly:"This is a historical Attempt. Actions apply only to the current Attempt.",
    task:"Task",attempt:"Attempt",workspace:"Workspace",updated:"Updated",model:"Model",plan:"Plan",discount:"Discount",effort:"Effort",status:"Status",result:"Result",
    notObserved:"Not observed",notAvailable:"Not available",dash:"--",unknown:"Unknown",
    modelObserved:"Observed",modelRequested:"Requested",modelNotObserved:"Not observed",
    planCoding:"Coding Plan",planStart:"Start Plan",planOther:"Other",planNotObserved:"Not observed",
    applied:"Applied",notApplied:"Not applied",notApplicable:"Not applicable",
    inputTokens:"Input tokens",outputTokens:"Output tokens",cacheRead:"Cache read",cacheWrite:"Cache write",reasoning:"Reasoning",totalTokens:"Total tokens",
    providerActualCost:"Provider actual cost",providerCostUnavailable:"No provider settlement was recorded for this Attempt.",
    masterUsage:"Master usage",workerUsage:"Worker usage",workerUsageHint:"Tokens recorded for this Attempt.",masterUsageUnavailable:"Master token usage is not recorded by this Task.",
    usageNotObserved:"Usage was not observed. This is not zero.",usageSource:"Usage source",finality:"Finality",observedAt:"Observed at",
    tokens:"{n} tokens",oneFileChanged:"{n} file changed",filesChangedCount:"{n} files changed",
    noTests:"No tests reported",testsSummary:"{passed} passed",testsFailedSummary:"{failed} failed",testsNotRunSummary:"{notRun} not run",
    events:"Events",loadingEvents:"Loading all Events...",eventsComplete:"All Events loaded",eventsFiltered:"Attempt {n}",eventsCount:"{n} Events",eventsEmpty:"No Events were recorded for this Attempt.",
    showDetails:"Details",hideDetails:"Hide details",
    executorUnavailable:"Executor unavailable.",executorRecoveryHint:"Opening or acting on a Task will attempt local Lease recovery; no second Worker is started while the previous Worker is alive.",
    diagnosticsTitle:"Diagnostics and explicit operations",close:"Close",
    diagNotice:"Experimental entry points. Opening this dialog performs no model, Runtime-probe or Billing request; every external read or write below is an explicit click.",
    runtime:"Runtime",runtimeHelp:"Static installation inspection, authorized zero-model protocol probe, and candidate report export.",
    inspectRuntime:"Inspect",staticCheck:"Static check",protocolProbe:"Protocol probe",exportReport:"Export report",
    costLab:"Cost evidence",costHelp:"Installation environment and historical evidence. A verification entry only loads its explicit confirmation state; it is not started here.",
    loadEnvironment:"Environment",loadHistory:"History",loadVerification:"Verification entry",settings:"Settings",
    autoWakeHelp:"Auto Wake defaults on. Turning it off records web_notify/auto_wake_disabled instead of calling the official Queue.",autoWake:"Auto Wake",saveSettings:"Save setting",
    settingsLoaded:"Settings loaded.",settingsSaved:"Auto Wake setting saved.",runtimeInspectFailed:"Runtime inspection failed.",costEnvironmentLoaded:"Cost evidence environment loaded.",costHistoryLoaded:"Cost evidence history loaded.",verificationLoaded:"Verification entry loaded. Starting it requires the existing explicit confirmation flow.",reportReady:"Candidate report downloaded.",reportUnavailable:"Candidate report is unavailable.",noHistory:"No historical evidence returned.",diagNoOutput:"Choose an explicit diagnostics operation.",
    taskActionDone:"Request accepted.",loadingDetail:"Loading task details...",
    wakeNotObserved:"No Wake observed",wakeWebNotifyShort:"Web notification",wakeSubmissionUnknownShort:"Needs verification",wakeIntent:"Delivery intent recorded",wakeQueued:"Queued for delivery",wakeTurnStarted:"New Turn started",
    release:"Release",releaseHeld:"Release is held.",releaseNotReleased:"Not released.",released:"Released",releaseVerified:"Cleanup verified at Release",releaseUnverified:"Released without verified Cleanup",
    cleanupIdentityUnverified:"Cleanup could not be verified because the Worker identity could not be confirmed. Nothing was released."
  },
  "zh-CN":{
    brand:"Bridge Task Console",language:"语言",theme:"主题",themeSystem:"跟随系统",themeLight:"浅色",themeDark:"深色",
    diagnostics:"诊断",titleTasks:"任务",experimental:"实验性",
    experimentalNotice:"实验性功能：任务状态与恢复操作仍在持续完善。",
    lede:"查看任务状态、结果与可用的恢复操作。",
    running:"进行中",attention:"需处理",completed:"已完成",waitingMasterShort:"等待 Master",
    searchTasks:"搜索任务（名称或 Workspace）",filterTasks:"任务筛选",allTasks:"全部任务",refresh:"刷新",
    loadingTasks:"正在读取任务...",noTasks:"没有符合筛选条件的任务。",chooseTask:"选择一个任务，查看状态、结果与下一步。",
    refreshFailed:"刷新任务列表失败。",detailFailed:"读取该任务失败。",invalidTask:"Task ID 无效。",sessionOffline:"Executor 会话不可用。",
    completedReviewPending:"已完成 · 待验收",completedReviewBlocked:"已完成 · 验收受阻",
    problemActions:"问题与操作",workHistory:"执行历史",execution:"执行消耗",technicalDetails:"技术详情",
    technicalHint:"Wake · Cleanup · Release · Events",
    completedNotAccepted:"Completed 不等于验收，仍需 Master 复核。",
    review:"验收",current:"当前",usageSummaryNotObserved:"未观测到 Usage",modelPlanNotObserved:"模型与套餐未观测",
    waitingMaster:"等待 Master 复核。本页面不会伪造验收。",
    workerActive:"Worker 或派发仍在进行，继续与关联返工保持禁用。",
    resultFailed:"Result 失败",resultFailedHint:"Worker Result 失败。这不是 Master 验收结论；请检查错误并选择安全的恢复操作。",
    resultIssues:"Result 问题",resultIssuesHint:"Worker 报告了问题。这不是 Master 验收结论；请先复核 Result 再选择下一步。",
    cleanup:"Cleanup",cleanupPending:"Cleanup 仍在等待。",cleanupUnverified:"Cleanup 未验证，Release 未被证明。",cleanupVerified:"Cleanup 已验证。",cleanupNotRequired:"无需 Cleanup。",cleanupNotStarted:"Cleanup 尚未开始。",cleanupPendingShort:"等待中。",cleanupUnverifiedShort:"未验证，Release 未被证明。",
    wake:"Wake",wakeSubmissionUnknown:"Queue 状态需要核实；页面不会自动重发。",wakeWebNotify:"仅 Web 通知，未打开官方 Queue。",
    hold:"Hold",holdActive:"活动 Hold：{reason}",noAttentionItems:"当前没有阻塞问题。",
    pendingInteraction:"待处理交互",replyUnknownWarning:"上一次回复可能已到达 Worker。请先对账，不要自动重发；本页面不会自动重发。",
    needsMaster:"需要 Master 决策",resultSubmissionError:"Result 提交错误",
    resultFor:"Attempt {n} 的 Result",resultMissing:"该 Attempt 未观测到 Result。",resultDetails:"Result 详情",
    issues:"问题",filesChanged:"变更文件",tests:"测试",started:"开始",finished:"结束",
    workerCompleted:"Worker 已完成，未记录 Master 验收结论。",workerFailed:"Worker 失败，未记录 Master 验收结论。",
    workerCancelled:"Worker 执行已取消。",masterReviewPending:"Worker 已完成，等待 Master 复核。",
    masterAcceptanceNotRecorded:"该任务未记录 Master 验收结论。",masterAccepted:"Master 已验收。",
    continue:"继续",continueHint:"基于这个已 Release 的 Result 创建下一个 Attempt。",continueFeedback:"给下一个 Attempt 的反馈",continueRequirements:"补充要求，每行一条",continueSubmit:"开始继续",
    rework:"创建关联返工",reworkHint:"会创建一个新 Task，继承原目标与验收边界；原 Task、Attempt 与结果完整保留。",reworkFeedback:"给新 Task 的审查反馈",reworkSubmit:"创建返工 Task",
    reply:"回复",replyForm:"回复权限请求",request:"请求",decision:"决定",reason:"原因",sendReply:"发送回复",
    decisionAllow:"允许",decisionDeny:"拒绝",decisionAccept:"接受",decisionDecline:"不接受",
    cancel:"请求取消",cancelConfirm:"请求取消当前 Attempt？这不会强制 Release。",
    cleanupRecovery:"恢复 Cleanup",cleanupRecoveryConfirm:"重新核对 Worker 与 Cleanup 事实？此操作不会清除 Hold，也不会绕过任务状态机。",
    actionUnavailable:"当前任务暂时没有安全可执行的动作。",actionBlocked:"阻塞原因：{reasons}。",
    continueSafe:"该 Result 已 Release，可以安全继续。",reworkSafe:"创建一个继承原目标与验收边界的关联返工 Task。",
    cleanupNeedsVerification:"Cleanup 验证通过前，不能继续或创建关联返工。",
    historicalReadOnly:"这是历史 Attempt，动作只作用于当前 Attempt。",
    task:"任务",attempt:"Attempt",workspace:"Workspace",updated:"更新时间",model:"模型",plan:"套餐",discount:"优惠",effort:"Effort",status:"状态",result:"Result",
    notObserved:"未观测",notAvailable:"不可用",dash:"--",unknown:"未知",
    modelObserved:"已观测",modelRequested:"请求值",modelNotObserved:"未观测",
    planCoding:"Coding Plan",planStart:"Start Plan",planOther:"其他",planNotObserved:"未观测",
    applied:"已应用",notApplied:"未应用",notApplicable:"不适用",
    inputTokens:"输入 tokens",outputTokens:"输出 tokens",cacheRead:"缓存读取",cacheWrite:"缓存写入",reasoning:"推理 tokens",totalTokens:"总 tokens",
    providerActualCost:"Provider 实际成本",providerCostUnavailable:"该 Attempt 没有记录 Provider 结算金额。",
    masterUsage:"Master 消耗",workerUsage:"Worker 消耗",workerUsageHint:"该 Attempt 记录的 Token 消耗。",masterUsageUnavailable:"该任务没有记录 Master Token 消耗。",
    usageNotObserved:"未观测到 Usage；这不等于 0。",usageSource:"Usage 来源",finality:"最终性",observedAt:"观测时间",
    tokens:"{n} tokens",oneFileChanged:"变更 {n} 个文件",filesChangedCount:"变更 {n} 个文件",
    noTests:"未报告测试",testsSummary:"{passed} 通过",testsFailedSummary:"{failed} 失败",testsNotRunSummary:"{notRun} 未运行",
    events:"Events",loadingEvents:"正在加载完整 Events...",eventsComplete:"全部 Events 已加载",eventsFiltered:"Attempt {n}",eventsCount:"{n} 条 Events",eventsEmpty:"该 Attempt 没有记录 Events。",
    showDetails:"详情",hideDetails:"收起详情",
    executorUnavailable:"Executor 不可用。",executorRecoveryHint:"打开任务或执行操作会尝试本地 Lease 恢复；原 Worker 仍存活时不会启动第二个 Worker。",
    diagnosticsTitle:"诊断与显式操作",close:"关闭",
    diagNotice:"实验性入口。打开本对话框不会发出模型、Runtime 探针或 Billing 请求；以下外部读取或写入都必须由你显式点击。",
    runtime:"Runtime",runtimeHelp:"静态安装检查、授权的零模型协议检查与 Candidate Report 导出。",
    inspectRuntime:"检查",staticCheck:"静态检查",protocolProbe:"协议探针",exportReport:"导出报告",
    costLab:"成本证据",costHelp:"安装环境与历史证据；验证入口只加载显式确认状态，不会在这里启动。",
    loadEnvironment:"环境",loadHistory:"历史",loadVerification:"验证入口",settings:"设置",
    autoWakeHelp:"Auto Wake 默认开启。关闭后 Worker 完成只记录 web_notify/auto_wake_disabled，不调用官方 Queue。",autoWake:"Auto Wake",saveSettings:"保存设置",
    settingsLoaded:"设置已读取。",settingsSaved:"Auto Wake 设置已保存。",runtimeInspectFailed:"Runtime 检查失败。",costEnvironmentLoaded:"成本证据环境已读取。",costHistoryLoaded:"成本证据历史已读取。",verificationLoaded:"验证入口已读取；启动仍需既有显式确认流程。",reportReady:"Candidate Report 已下载。",reportUnavailable:"Candidate Report 不可用。",noHistory:"没有历史证据。",diagNoOutput:"请选择一个显式诊断操作。",
    taskActionDone:"请求已受理。",loadingDetail:"正在读取任务详情...",
    wakeNotObserved:"未观测到 Wake",wakeWebNotifyShort:"仅 Web 通知",wakeSubmissionUnknownShort:"需要核实",wakeIntent:"已记录投递意图",wakeQueued:"已进入投递队列",wakeTurnStarted:"已开始新 Turn",
    release:"Release",releaseHeld:"Release 被 Hold 阻止。",releaseNotReleased:"尚未 Release。",released:"已 Release",releaseVerified:"Release 时 Cleanup 已验证",releaseUnverified:"已 Release，但 Cleanup 未验证",
    cleanupIdentityUnverified:"无法确认 Worker 身份，Cleanup 未能验证；没有执行 Release。"
  }
};
var STATUS={
  en:{queued:"Queued",running:"Running",completed:"Completed",failed:"Failed",cancelled:"Cancelled",waiting_for_master:"Waiting for Master"},
  "zh-CN":{queued:"排队中",running:"执行中",completed:"已完成",failed:"失败",cancelled:"已取消",waiting_for_master:"等待 Master"}
};
var REASON={
  en:{pending_interaction:"Pending interaction",interaction_reply_outcome_unknown:"Reply outcome unknown",cleanup_pending:"Cleanup pending",cleanup_unverified:"Cleanup unverified",waiting_for_master:"Waiting for Master",needs_master_decision:"Needs Master decision",task_failed:"Task failed",worker_active:"Task is still running",wake_submission_unknown:"Queue state needs verification",wake_web_notify:"Web notification",result_submission_failed:"Result submission failed",release_not_completed:"Release is not complete",release_cleanup_unverified:"Release Cleanup is unverified",administrative_release_unverified:"Administrative Release is unverified"},
  "zh-CN":{pending_interaction:"待处理交互",interaction_reply_outcome_unknown:"回复结果未知",cleanup_pending:"Cleanup 等待中",cleanup_unverified:"Cleanup 未验证",waiting_for_master:"等待 Master",needs_master_decision:"需要 Master 决策",task_failed:"任务失败",worker_active:"任务仍在运行",wake_submission_unknown:"Queue 状态需要核实",wake_web_notify:"Web 通知",result_submission_failed:"Result 提交失败",release_not_completed:"Release 尚未完成",release_cleanup_unverified:"Release 时 Cleanup 未验证",administrative_release_unverified:"管理式 Release 未验证"}
};
var state={lang:"zh-CN",theme:"system",tasks:[],detail:null,detailError:"",listError:"",selected:null,selectedAttempt:null,filter:null,query:"",csrf:"",session:null,sessionLoaded:false,events:{taskId:null,rows:[],complete:false,loading:false,error:"",loaded:false},eventsOpen:false,technicalOpen:false,executionOpen:false,actionForm:null,busy:false,refreshTimer:null,settingsLoaded:false,settings:null,diagOutput:""};
function $(selector){return document.querySelector(selector);}
function el(tag,cls,text){var node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined&&text!==null)node.textContent=String(text);return node;}
function t(key,vars){var table=TEXT[state.lang]||TEXT.en;var value=table[key]||TEXT.en[key]||key;if(vars){Object.keys(vars).forEach(function(name){value=value.split("{"+name+"}").join(String(vars[name]));});}return value;}
function statusLabel(value){var table=STATUS[state.lang]||STATUS.en;return table[value]||value||t("unknown");}
function reasonLabel(value){var table=REASON[state.lang]||REASON.en;if(value&&value.indexOf("hold:")===0)return t("hold")+": "+(table[value.slice(5)]||value.slice(5));return table[value]||value;}
function chip(text,cls){return el("span","status-chip "+(cls||""),text);}
function number(value){return typeof value==="number"&&Number.isFinite(value)?value.toLocaleString(state.lang):t("dash");}
function formatDate(value){if(!value)return t("dash");var date=new Date(value);if(Number.isNaN(date.getTime()))return t("dash");return date.toLocaleString(state.lang);}
function formatShortDate(value){if(!value)return t("dash");var date=new Date(value);if(Number.isNaN(date.getTime()))return t("dash");try{return date.toLocaleString(state.lang,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});}catch(_ignore){return formatDate(value);}}
function workspaceShort(value){var text=String(value||"").trim();if(!text)return t("notObserved");var parts=text.split(/[\\/]+/).filter(Boolean);return parts.length?parts[parts.length-1]:text;}
function setError(message){var box=$("#global-error");if(!box)return;box.textContent=message||"";box.classList.toggle("visible",Boolean(message));}
function toast(message,error){var node=$("#toast");if(!node)return;node.textContent=message;node.classList.toggle("error",Boolean(error));node.classList.add("show");clearTimeout(toast._timer);toast._timer=setTimeout(function(){node.classList.remove("show");},3200);}
function errorMessage(error){if(!error)return t("unknown");return error.message||String(error);}
function errorCode(error){return error&&error.code?error.code:"";}
function friendlyError(error){var code=errorCode(error);var message=errorMessage(error);if(code==="CANCEL_FAILED"&&message.indexOf("worker_identity_unverifiable")>=0)return t("cleanupIdentityUnverified");return message;}
async function api(path,options){var opts=options||{};var headers=Object.assign({},opts.headers||{});if(opts.body!==undefined)headers["Content-Type"]="application/json";if(opts.csrf){if(!state.csrf){await loadSession();}headers["X-ZCode-Bridge-CSRF"]=state.csrf;}var response=await fetch(path,{method:opts.method||"GET",headers:headers,body:opts.body});var text=await response.text();var json=null;try{json=text?JSON.parse(text):null;}catch(_ignore){json=null;}if(!response.ok||!json||json.ok===false){var error=new Error((json&&json.error&&json.error.message)||text||("HTTP "+response.status));error.code=json&&json.error&&json.error.code||("HTTP_"+response.status);throw error;}return json.result!==undefined?json.result:(json.data!==undefined?json.data:json);}
function taskIdFromLocation(){try{return new URL(location.href).searchParams.get("task_id");}catch(_ignore){return null;}}
function setTaskInLocation(id){try{var url=new URL(location.href);if(id)url.searchParams.set("task_id",id);else url.searchParams.delete("task_id");history.replaceState(null,"",url.pathname+url.search+url.hash);}catch(_ignore){}}
function applyTheme(){document.documentElement.setAttribute("data-theme",state.theme);try{localStorage.setItem("bridge.ui.theme",state.theme);}catch(_ignore){}}
function applyLanguage(){document.documentElement.setAttribute("lang",state.lang);try{localStorage.setItem("bridge.ui.language",state.lang);}catch(_ignore){}var lang=$("#language");if(lang)lang.value=state.lang;document.querySelectorAll("[data-i18n]").forEach(function(node){node.textContent=t(node.getAttribute("data-i18n"));});var searchBox=$("#task-search");if(searchBox)searchBox.placeholder=t("searchTasks");var bucket=$("#bucket-filter");if(bucket)bucket.setAttribute("aria-label",t("filterTasks"));var notice=$("#experimental-notice");if(notice)notice.title=t("experimentalNotice");document.title=t("brand");renderExecutor();renderList();renderDetail();}
function taskBucket(task){if(task.needs_attention)return "attention";if(task.status==="queued"||task.status==="running")return "running";return "completed";}
function counts(){var result={running:0,attention:0,completed:0};state.tasks.forEach(function(task){result[taskBucket(task)]+=1;});return result;}
function modelText(model){if(!model||model.state==="not_observed")return t("modelNotObserved");return model.model_id||t("dash");}
function modelSourceText(model){if(!model)return t("modelNotObserved");if(model.state==="observed")return t("modelObserved");if(model.state==="requested")return t("modelRequested");return t("modelNotObserved");}
function planText(plan){if(!plan||plan.kind==="not_observed")return t("planNotObserved");if(plan.kind==="coding_plan")return t("planCoding");if(plan.kind==="start_plan")return t("planStart");return t("planOther");}
function discountText(discount){if(!discount)return t("notObserved");if(discount.state==="applied")return t("applied");if(discount.state==="not_applied")return t("notApplied");if(discount.state==="not_applicable")return t("notApplicable");return t("notObserved");}
function cleanupText(cleanup){if(!cleanup||cleanup.state==="not_started")return t("cleanupNotStarted");if(cleanup.state==="not_required")return t("cleanupNotRequired");if(cleanup.state==="pending")return t("cleanupPending");if(cleanup.state==="verified")return t("cleanupVerified");if(cleanup.state==="unverified")return t("cleanupUnverified");return t("unknown");}
function releaseText(release){if(!release||release.state==="not_released")return t("releaseNotReleased");if(release.state==="held")return t("releaseHeld");if(release.state==="released")return t("released");return t("unknown");}
function effortText(model){var effort=model&&model.effort;if(!effort||effort.state==="not_observed"||!effort.value)return t("notObserved");return effort.value;}
function effortSourceText(model){var effort=model&&model.effort;if(!effort||effort.state==="not_observed")return t("notObserved");return effort.state==="observed"?t("modelObserved"):t("modelRequested");}
function metricText(value){return value===null||value===undefined?t("notObserved"):number(value);}
function usageTotalText(usage){if(!usage||usage.state!=="observed"||usage.total_tokens===null||usage.total_tokens===undefined)return t("notObserved");return t("tokens",{n:number(usage.total_tokens)});}
function modelPlanText(attempt){
  var modelObserved=attempt&&attempt.model&&attempt.model.state!=="not_observed";
  var planObserved=attempt&&attempt.plan&&attempt.plan.kind!=="not_observed";
  if(!modelObserved&&!planObserved)return t("modelPlanNotObserved");
  return modelText(attempt&&attempt.model)+" / "+planText(attempt&&attempt.plan);
}
function executionSummaryValues(attempt){
  var values=[];
  if(attempt.model&&attempt.model.state!=="not_observed")values.push(modelText(attempt.model));
  if(attempt.plan&&attempt.plan.kind!=="not_observed")values.push(planText(attempt.plan));
  if(attempt.discount&&attempt.discount.state!=="not_observed")values.push(discountText(attempt.discount));
  var usage=attempt.usage;
  if(usage&&usage.state==="observed"&&usage.total_tokens!==null&&usage.total_tokens!==undefined)values.push(t("tokens",{n:number(usage.total_tokens)}));
  if(!values.length)values.push(t("usageSummaryNotObserved"));
  return values;
}
function taskTitle(task){return task&&task.name||task&&task.objective||(task&&task.task_id)||t("task");}
function taskMatchesQuery(task,query){if(!query)return true;var hay=[taskTitle(task),task.task_id,task.workspace,task.objective].join(" ").toLowerCase();return hay.indexOf(query)>=0;}
function taskStatusMeta(task){
  var label=statusLabel(task.status),cls=task.status;
  if(task.status==="completed"){
    var caps=task.action_capabilities||{};
    if(caps.can_continue||caps.can_rework){label=t("completedReviewPending");cls="completed review-pending";}
    else{label=t("completedReviewBlocked");cls="completed review-blocked";}
  }
  if(task.status==="waiting_for_master"){label=t("waitingMasterShort");cls="waiting_for_master";}
  return {label:label,cls:cls};
}
function attentionSummary(task){
  var reasons=Array.isArray(task.attention_reasons)?task.attention_reasons:[];
  var labels=[];
  reasons.forEach(function(reason){var label=reasonLabel(reason);if(labels.indexOf(label)<0)labels.push(label);});
  var shown=labels.slice(0,2);
  if(labels.length>2)shown.push("+"+String(labels.length-2));
  return shown.join(" · ");
}
function metaItem(text,mono){return el("span","task-meta-item"+(mono?" mono":""),text);}
function reviewSemantics(detail,attempt){
  var result=attempt&&attempt.result;
  if(!result)return "";
  if(result.status==="failed")return t("workerFailed");
  if(detail.master_accepted===true)return t("masterAccepted");
  if(detail.status==="waiting_for_master")return t("masterReviewPending");
  if(detail.status==="completed")return t("masterAcceptanceNotRecorded");
  if(result.status==="cancelled")return t("workerCancelled");
  return t("workerCompleted");
}
function fileSummary(count){return count===1?t("oneFileChanged",{n:count}):t("filesChangedCount",{n:count});}
function testsSummary(tests){
  var values=Array.isArray(tests)?tests:[];
  if(!values.length)return t("noTests");
  var passed=values.filter(function(test){return test.status==="passed";}).length;
  var failed=values.filter(function(test){return test.status==="failed";}).length;
  var notRun=values.filter(function(test){return test.status==="not_run";}).length;
  var parts=[];
  if(passed)parts.push(t("testsSummary",{passed:passed}));
  if(failed)parts.push(t("testsFailedSummary",{failed:failed}));
  if(notRun)parts.push(t("testsNotRunSummary",{notRun:notRun}));
  return parts.join(" · ");
}
function renderExecutor(){
  var notice=$("#executor-notice");if(!notice)return;
  if(!state.sessionLoaded){notice.hidden=true;notice.textContent="";return;}
  var status=state.session&&state.session.state?String(state.session.state):"unknown";
  notice.setAttribute("data-state",status);
  if(status==="active"||status==="idle"){notice.hidden=true;notice.textContent="";return;}
  notice.hidden=false;notice.textContent=t("executorUnavailable")+" "+t("executorRecoveryHint");
}
function renderList(){renderTaskInbox();}
function renderTaskInbox(){
  var list=$("#task-list");if(!list)return;
  var current=counts();
  $("#count-running").textContent=current.running;
  $("#count-attention").textContent=current.attention;
  $("#count-completed").textContent=current.completed;
  document.querySelectorAll(".summary-item").forEach(function(button){
    var active=button.getAttribute("data-filter")===state.filter;
    button.classList.toggle("active",active);
    button.setAttribute("aria-pressed",active?"true":"false");
  });
  var bucket=$("#bucket-filter");if(bucket)bucket.value=state.filter||"";
  list.replaceChildren();
  if(state.listError){list.appendChild(el("div","empty",state.listError));return;}
  var query=String(state.query||"").trim().toLowerCase();
  var visible=state.tasks.filter(function(task){return (!state.filter||taskBucket(task)===state.filter)&&taskMatchesQuery(task,query);})
    .sort(function(a,b){
      if(Boolean(a.needs_attention)!==Boolean(b.needs_attention))return a.needs_attention?-1:1;
      return String(b.updated_at||"").localeCompare(String(a.updated_at||""))||String(a.task_id).localeCompare(String(b.task_id));
    });
  if(!visible.length){list.appendChild(el("div","empty",t("noTasks")));return;}
  visible.forEach(function(task){
    var meta=taskStatusMeta(task);
    var button=el("button","task-row "+(task.task_id===state.selected?"selected ":"")+(task.needs_attention?"attention":""));
    button.type="button";
    button.setAttribute("data-task-id",task.task_id);
    button.setAttribute("aria-label",taskTitle(task)+", "+meta.label+(task.needs_attention?", "+attentionSummary(task):""));
    var main=el("span","task-main");
    var line1=el("span","task-line task-line-title");
    line1.appendChild(el("span","task-name",taskTitle(task)));
    line1.appendChild(chip(meta.label,meta.cls));
    main.appendChild(line1);
    var line2=el("span","task-line task-line-meta");
    line2.appendChild(metaItem(workspaceShort(task.workspace)));
    if(modelPlanText({model:task.model,plan:task.plan})===t("modelPlanNotObserved")){
      line2.appendChild(metaItem(t("modelPlanNotObserved")));
    }else{
      line2.appendChild(metaItem(modelText(task.model)));
      line2.appendChild(metaItem(planText(task.plan)));
    }
    line2.appendChild(metaItem(t("attempt")+" #"+String(task.attempt)));
    line2.appendChild(metaItem(formatShortDate(task.updated_at)));
    main.appendChild(line2);
    if(task.needs_attention){
      var problem=attentionSummary(task);
      if(problem)main.appendChild(el("span","task-line task-line-problem",problem));
    }
    button.appendChild(main);
    button.addEventListener("click",function(){void selectTask(task.task_id,true);});
    list.appendChild(button);
  });
}
function sectionTitle(title,subtitle){
  var head=el("div","region-title");
  head.appendChild(el("h3","",title));
  if(subtitle)head.appendChild(el("small","",subtitle));
  return head;
}
function renderDetail(){renderDetailV2();}
function renderDetailV2(){
  var target=$("#task-detail");if(!target)return;
  target.replaceChildren();
  if(!state.selected){target.appendChild(el("div","detail-empty",t("chooseTask")));return;}
  if(state.detailError){target.appendChild(el("p","action-note blocked",state.detailError));return;}
  if(!state.detail){target.appendChild(el("div","detail-empty",t("loadingDetail")));return;}
  var detail=state.detail;
  var attempt=currentAttempt();
  if(!attempt){target.appendChild(el("div","detail-empty",t("chooseTask")));return;}
  var meta=taskStatusMeta(detail);
  var header=el("header","task-header");
  header.setAttribute("data-region","header");
  var title=el("div","detail-title");
  var left=el("div","detail-title-main");
  left.appendChild(el("h2","",taskTitle(detail)));
  if(detail.objective&&detail.objective!==taskTitle(detail))left.appendChild(el("p","",detail.objective));
  var context=el("div","detail-context");
  context.appendChild(el("span","detail-task-id mono",detail.task_id));
  context.appendChild(el("span","detail-context-sep","·"));
  context.appendChild(el("span","",t("attempt")+" #"+String(attempt.attempt)));
  context.appendChild(el("span","detail-context-sep","·"));
  context.appendChild(el("span","",modelPlanText(attempt)));
  context.appendChild(el("span","detail-context-sep","·"));
  context.appendChild(el("span","",t("updated")+" "+formatDate(detail.updated_at)));
  left.appendChild(context);
  var chips=el("div","hero-chips");
  chips.appendChild(chip(meta.label,meta.cls));
  if(detail.needs_attention)chips.appendChild(chip(t("attention"),"review-blocked"));
  title.appendChild(left);title.appendChild(chips);header.appendChild(title);
  var pathLine=el("div","detail-path");
  pathLine.appendChild(el("span","detail-path-label",t("workspace")));
  pathLine.appendChild(el("code","",detail.workspace||t("notObserved")));
  header.appendChild(pathLine);
  target.appendChild(header);
  target.appendChild(renderProblemActions(detail,attempt,attempt.attempt===detail.attempt));
  target.appendChild(renderWorkHistory(detail,attempt));
  target.appendChild(renderExecution(detail,attempt));
  target.appendChild(renderTechnicalDetails(attempt));
}
function problemItems(detail,attempt){
  var items=[];
  var result=attempt.result;
  var resultFailed=Boolean(result&&(result.status==="failed"||result.error_code));
  if(resultFailed){
    items.push({kind:"bad",label:t("resultFailed"),text:(result.error_code?result.error_code+". ":"")+t("resultFailedHint")});
  }
  if(result&&result.issues&&result.issues.length){
    var issues=result.issues.slice(0,2).join(" · ");
    if(result.issues.length>2)issues+=" +"+(result.issues.length-2);
    items.push({kind:resultFailed?"bad":"warn",label:t("resultIssues"),text:issues});
  }
  if(result&&result.needs_master_decision)items.push({kind:"warn",label:t("needsMaster"),text:t("waitingMaster")});
  if(attempt.pending_requests&&attempt.pending_requests.length)items.push({kind:"warn",label:t("pendingInteraction"),text:attempt.pending_requests.join(" · ")});
  if(attempt.reply_outcome_unknown_requests&&attempt.reply_outcome_unknown_requests.length)items.push({kind:"bad",label:t("replyUnknownWarning"),text:""});
  if(attempt.cleanup&&attempt.cleanup.state==="pending")items.push({kind:"warn",label:t("cleanup"),text:t("cleanupPendingShort")});
  if(attempt.cleanup&&attempt.cleanup.state==="unverified")items.push({kind:"warn",label:t("cleanup"),text:t("cleanupUnverifiedShort")});
  if(attempt.hold&&attempt.hold.active)items.push({kind:"bad",label:t("hold"),text:(attempt.hold.reason_code||t("unknown"))+(attempt.hold.at?" · "+formatDate(attempt.hold.at):"")});
  if(attempt.wake&&attempt.wake.state==="submission_unknown")items.push({kind:"warn",label:t("wake"),text:t("wakeSubmissionUnknown")});
  if(attempt.wake&&attempt.wake.state==="web_notify")items.push({kind:"info",label:t("wake"),text:t("wakeWebNotify")});
  if(detail.result_submission_error)items.push({kind:"bad",label:t("resultSubmissionError"),text:detail.result_submission_error});
  if(detail.status==="waiting_for_master")items.push({kind:"warn",label:t("review"),text:t("waitingMaster")});
  if(detail.status==="completed")items.push({kind:"info",label:t("review"),text:t("completedNotAccepted")});
  if(detail.status==="failed"&&!resultFailed)items.push({kind:"bad",label:statusLabel("failed"),text:t("resultFailedHint")});
  if(detail.status==="queued"||detail.status==="running")items.push({kind:"info",label:statusLabel(detail.status),text:t("workerActive")});
  if(!items.length)items.push({kind:"ok",label:t("noAttentionItems"),text:""});
  return items;
}
function severity(items){var rank={bad:4,warn:3,info:2,ok:1};var top="ok";items.forEach(function(item){if(rank[item.kind]>rank[top])top=item.kind;});return top;}
function actionBlockerReasons(caps){
  var blockers=Array.isArray(caps.blockers)?caps.blockers:[];
  var labels=[];
  blockers.forEach(function(reason){
    if((reason==="release_not_completed"||reason==="release_cleanup_unverified")&&
      (blockers.indexOf("cleanup_unverified")>=0||blockers.indexOf("cleanup_pending")>=0))return;
    if((reason==="cleanup_unverified"||reason==="cleanup_pending")&&blockers.indexOf("worker_active")>=0)return;
    var label=reasonLabel(reason);
    if(labels.indexOf(label)<0)labels.push(label);
  });
  return labels;
}
function renderProblemActions(detail,attempt,current){
  var section=el("section","region");
  section.setAttribute("data-section","problem-actions");
  section.appendChild(sectionTitle(t("problemActions")));
  var items=problemItems(detail,attempt);
  var box=el("div","problem "+severity(items));
  items.forEach(function(item){
    var line=el("p","problem-line");
    line.appendChild(el("strong","",item.label));
    if(item.text){
      line.appendChild(el("span","problem-sep",": "));
      line.appendChild(document.createTextNode(item.text));
    }
    box.appendChild(line);
  });
  section.appendChild(box);
  var caps=detail.action_capabilities||{};
  if(!current){section.appendChild(el("p","action-note",t("historicalReadOnly")));return section;}
  var actions=el("div","actions");
  if(caps.can_continue){var continueButton=el("button","button primary",t("continue"));continueButton.type="button";continueButton.addEventListener("click",function(){state.actionForm=state.actionForm==="continue"?null:"continue";renderDetail();});actions.appendChild(continueButton);}
  if(caps.can_rework){var reworkButton=el("button","button",t("rework"));reworkButton.type="button";reworkButton.addEventListener("click",function(){state.actionForm=state.actionForm==="rework"?null:"rework";renderDetail();});actions.appendChild(reworkButton);}
  if(caps.can_recover_cleanup){var recoverButton=el("button","button",t("cleanupRecovery"));recoverButton.type="button";recoverButton.addEventListener("click",function(){void recoverCleanup();});actions.appendChild(recoverButton);}
  if(caps.can_reply){var replyButton=el("button","button",t("reply"));replyButton.type="button";replyButton.addEventListener("click",function(){state.actionForm=state.actionForm==="reply"?null:"reply";renderDetail();});actions.appendChild(replyButton);}
  if(caps.can_cancel){var cancelButton=el("button","button danger",t("cancel"));cancelButton.type="button";cancelButton.addEventListener("click",function(){void cancelTask();});actions.appendChild(cancelButton);}
  if(actions.children.length)section.appendChild(actions);
  if(caps.can_continue)section.appendChild(el("p","action-note",t("continueSafe")));
  else if(caps.can_rework)section.appendChild(el("p","action-note",t("reworkSafe")));
  else if(caps.can_recover_cleanup)section.appendChild(el("p","action-note",t("cleanupNeedsVerification")));
  if(!actions.children.length)section.appendChild(el("p","action-note",t("actionUnavailable")));
  var blockers=actionBlockerReasons(caps);
  if(!caps.can_continue&&!caps.can_rework&&blockers.length&&detail.status!=="queued"&&detail.status!=="running")section.appendChild(el("p","action-note blocked",t("actionBlocked",{reasons:blockers.join("; ")})));
  if(state.actionForm==="continue"&&caps.can_continue)section.appendChild(renderContinueForm());
  if(state.actionForm==="rework"&&caps.can_rework)section.appendChild(renderReworkForm());
  if(state.actionForm==="reply"&&caps.can_reply)section.appendChild(renderReplyForm(attempt));
  return section;
}
function renderWorkHistory(detail,attempt){
  var section=el("section","region");
  section.setAttribute("data-section","work-history");
  section.appendChild(sectionTitle(t("workHistory"),t("attempt")+" "+String(attempt.attempt)+" / "+String(detail.attempts.length)));
  var tabs=el("div","attempts");
  detail.attempts.forEach(function(item){
    var button=el("button","attempt"+(item.attempt===state.selectedAttempt?" active":""));
    button.type="button";
    button.setAttribute("aria-pressed",item.attempt===state.selectedAttempt?"true":"false");
    button.appendChild(el("strong","","Attempt #"+String(item.attempt)+(item.current?" · "+t("current"):"")));
    button.appendChild(el("span","",formatShortDate(item.updated_at)));
    button.appendChild(chip(statusLabel(item.status),item.status));
    button.addEventListener("click",function(){state.selectedAttempt=item.attempt;state.actionForm=null;renderDetail();if(state.eventsOpen)void ensureEvents(false);});
    tabs.appendChild(button);
  });
  section.appendChild(tabs);
  var result=attempt.result;
  var block=el("div","result-block");
  var head=el("div","result-head");
  head.appendChild(el("h4","",t("resultFor",{n:attempt.attempt})));
  head.appendChild(chip(result?statusLabel(result.status):t("notObserved"),result?result.status:""));
  block.appendChild(head);
  var semantics=reviewSemantics(detail,attempt);
  if(semantics)block.appendChild(el("p","result-semantics",semantics));
  if(result){
    if(result.summary)block.appendChild(el("p","result-summary",result.summary));
    var metrics=el("div","result-metrics");
    metrics.appendChild(el("span","",fileSummary(Array.isArray(result.files_changed)?result.files_changed.length:0)));
    metrics.appendChild(el("span","",testsSummary(result.tests)));
    block.appendChild(metrics);
    var hasDetails=(result.issues&&result.issues.length)||(result.files_changed&&result.files_changed.length)||(result.tests&&result.tests.length)||result.error_code||result.started_at||result.finished_at;
    if(hasDetails){
      var details=el("details","result-details");
      details.appendChild(el("summary","",t("resultDetails")));
      var body=el("div","result-detail-body");
      if(result.error_code){body.appendChild(el("p","detail-label",t("status")+"  "+result.error_code));}
      if(result.issues&&result.issues.length){
        body.appendChild(el("p","detail-label",t("issues")));
        var issueList=el("ul","detail-list");
        result.issues.forEach(function(issue){issueList.appendChild(el("li","",issue));});
        body.appendChild(issueList);
      }
      if(result.files_changed&&result.files_changed.length){
        body.appendChild(el("p","detail-label",t("filesChanged")));
        var files=el("ul","detail-list");
        result.files_changed.forEach(function(file){files.appendChild(el("li","",file));});
        body.appendChild(files);
      }
      if(result.tests&&result.tests.length){
        body.appendChild(el("p","detail-label",t("tests")));
        var tests=el("ul","detail-list");
        result.tests.forEach(function(test){
          var row=el("li","test-row"+(test.status==="failed"?" test-failed":test.status==="not_run"?" test-not-run":""));
          row.textContent=test.status+"  "+test.command+(test.details?"\n"+test.details:"");
          tests.appendChild(row);
        });
        body.appendChild(tests);
      }
      if(result.started_at||result.finished_at){
        var times=el("div","result-metrics");
        if(result.started_at)times.appendChild(el("span","",t("started")+" "+formatDate(result.started_at)));
        if(result.finished_at)times.appendChild(el("span","",t("finished")+" "+formatDate(result.finished_at)));
        body.appendChild(times);
      }
      details.appendChild(body);block.appendChild(details);
    }
  }else{
    block.appendChild(el("p","action-note",t("resultMissing")));
  }
  section.appendChild(block);
  return section;
}
function renderExecution(detail,attempt){
  var details=el("details","region execution-region");
  details.setAttribute("data-section","execution");
  details.open=state.executionOpen;
  var summary=el("summary","");
  summary.appendChild(el("span","execution-title",t("execution")));
  var line=el("span","execution-line");
  var values=executionSummaryValues(attempt);
  values.forEach(function(value,index){
    if(index)line.appendChild(el("span","execution-sep","·"));
    line.appendChild(el("span","",value));
  });
  summary.appendChild(line);
  details.appendChild(summary);
  details.addEventListener("toggle",function(){state.executionOpen=details.open;});
  var body=el("div","execution-body");
  var grid=el("div","exec-grid");
  grid.appendChild(execCell(t("model"),modelText(attempt.model)+" · "+modelSourceText(attempt.model)));
  grid.appendChild(execCell(t("effort"),effortText(attempt.model)+" · "+effortSourceText(attempt.model)));
  grid.appendChild(execCell(t("plan"),planText(attempt.plan)));
  grid.appendChild(execCell(t("discount"),discountText(attempt.discount)));
  var usage=attempt.usage||{state:"not_observed"};
  grid.appendChild(execCell(t("inputTokens"),metricText(usage.input_tokens)));
  grid.appendChild(execCell(t("outputTokens"),metricText(usage.output_tokens)));
  grid.appendChild(execCell(t("cacheRead"),metricText(usage.cached_input_tokens)));
  grid.appendChild(execCell(t("cacheWrite"),metricText(usage.cached_write_input_tokens)));
  grid.appendChild(execCell(t("reasoning"),metricText(usage.reasoning_tokens)));
  grid.appendChild(execCell(t("totalTokens"),metricText(usage.total_tokens)));
  body.appendChild(grid);
  var provider=el("div","provider-cost");
  provider.appendChild(el("strong","",t("providerActualCost")+": "+t("notObserved")));
  provider.appendChild(el("small","",t("providerCostUnavailable")));
  body.appendChild(provider);
  if(usage.state==="observed"){
    var sourceParts=[];
    if(usage.source)sourceParts.push(t("usageSource")+": "+usage.source);
    if(usage.finality)sourceParts.push(t("finality")+": "+usage.finality);
    if(usage.observed_at)sourceParts.push(t("observedAt")+": "+formatDate(usage.observed_at));
    if(sourceParts.length)body.appendChild(el("p","action-note",sourceParts.join(" · ")));
    if(usage.conflicts&&usage.conflicts.length)body.appendChild(el("p","action-note blocked",usage.conflicts.join(", ")));
  }else{
    body.appendChild(el("p","action-note",t("usageNotObserved")));
  }
  var worker=el("div","usage-scope");
  worker.appendChild(el("b","",t("workerUsage")+": "+usageTotalText(usage)));
  worker.appendChild(el("small","",usage.state==="observed"?t("workerUsageHint"):t("usageNotObserved")));
  body.appendChild(worker);
  var master=el("div","usage-scope");
  master.appendChild(el("b","",t("masterUsage")+": "+t("notObserved")));
  master.appendChild(el("small","",t("masterUsageUnavailable")));
  body.appendChild(master);
  details.appendChild(body);
  return details;
}
function execCell(label,value){
  var cell=el("div","exec-cell usage-fact");
  cell.appendChild(el("label","",label));
  cell.appendChild(el("strong","",value===null||value===undefined||value===""?t("dash"):String(value)));
  return cell;
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
function techItem(title,status,detail,note){
  var box=el("div","tech-item");
  box.appendChild(el("h4","",title));
  box.appendChild(el("strong","",status));
  if(detail)box.appendChild(el("small","",detail));
  if(note)box.appendChild(el("p","tech-note",note));
  return box;
}
function technicalReason(value){if(!value)return "";if(value==="released"||value==="verified"||value==="not_required"||value==="not_started")return "";return value;}
function renderTechnicalDetails(attempt){
  var details=el("details","region technical-region");
  details.setAttribute("data-section","technical-details");
  details.open=state.technicalOpen;
  var summary=el("summary","");
  summary.appendChild(el("span","execution-title",t("technicalDetails")));
  summary.appendChild(el("small","",t("technicalHint")));
  details.appendChild(summary);
  details.addEventListener("toggle",function(){state.technicalOpen=details.open;});
  var body=el("div","execution-body");
  var grid=el("div","tech-grid");
  if(attempt.wake){
    grid.appendChild(techItem(t("wake"),wakeLabel(attempt.wake.state),attempt.wake.reason_code+" · "+formatDate(attempt.wake.at),attempt.wake.state==="submission_unknown"?t("wakeSubmissionUnknown"):attempt.wake.state==="web_notify"?t("wakeWebNotify"):""));
  }else{
    grid.appendChild(techItem(t("wake"),t("wakeNotObserved"),"",""));
  }
  grid.appendChild(techItem(t("cleanup"),cleanupText(attempt.cleanup),technicalReason(attempt.cleanup&&attempt.cleanup.reason_code),""));
  grid.appendChild(techItem(t("release"),releaseText(attempt.release),technicalReason(attempt.release&&attempt.release.reason_code),attempt.release&&attempt.release.cleanup_verified!==null?(attempt.release.cleanup_verified?t("releaseVerified"):t("releaseUnverified")):""));
  body.appendChild(grid);
  body.appendChild(renderEventsV2(attempt));
  details.appendChild(body);
  return details;
}
function renderEventsV2(attempt){
  var details=el("details","events");
  details.open=state.eventsOpen;
  var summary=el("summary","");
  summary.textContent=t("events")+" · "+t("eventsFiltered",{n:attempt.attempt});
  details.appendChild(summary);
  var body=el("div","");
  body.id="events-body";
  body.appendChild(el("p","action-note",state.events.loading?t("loadingEvents"):t("eventsEmpty")));
  details.appendChild(body);
  details.addEventListener("toggle",function(){state.eventsOpen=details.open;if(details.open)void ensureEvents(false);else{var current=document.getElementById("events-body");if(current)renderEventsInto(current,attempt);}});
  if(state.eventsOpen)void ensureEvents(false);
  return details;
}
function renderContinueForm(){
  var form=el("form","form-card");
  form.appendChild(el("p","action-note",t("continueHint")));
  var feedback=el("label","",t("continueFeedback"));
  var text=el("textarea");text.name="feedback";text.required=true;feedback.appendChild(text);form.appendChild(feedback);
  var requirements=el("label","",t("continueRequirements"));
  var req=el("textarea");req.name="additional_requirements";requirements.appendChild(req);form.appendChild(requirements);
  var row=el("div","actions");
  var submit=el("button","button primary",t("continueSubmit"));submit.type="submit";row.appendChild(submit);form.appendChild(row);
  form.addEventListener("submit",function(event){event.preventDefault();void continueTask(text.value,req.value);});
  return form;
}
function renderReworkForm(){
  var form=el("form","form-card");
  form.appendChild(el("p","action-note",t("reworkHint")));
  var feedback=el("label","",t("reworkFeedback"));
  var text=el("textarea");text.name="feedback";text.required=true;feedback.appendChild(text);form.appendChild(feedback);
  var row=el("div","actions");
  var submit=el("button","button",t("reworkSubmit"));submit.type="submit";row.appendChild(submit);form.appendChild(row);
  form.addEventListener("submit",function(event){event.preventDefault();void reworkTask(text.value);});
  return form;
}
function renderReplyForm(attempt){
  var form=el("form","form-card");
  form.appendChild(el("p","action-note",t("replyForm")));
  var grid=el("div","form-grid");
  var request=el("label","",t("request"));
  var select=el("select");select.name="request_id";
  attempt.pending_requests.forEach(function(value){var option=el("option","",value);option.value=value;select.appendChild(option);});
  request.appendChild(select);grid.appendChild(request);
  var decision=el("label","",t("decision"));
  var decisionSelect=el("select");decisionSelect.name="decision";
  [["allow",t("decisionAllow")],["deny",t("decisionDeny")],["accept",t("decisionAccept")],["decline",t("decisionDecline")]].forEach(function(pair){var option=el("option","",pair[1]);option.value=pair[0];decisionSelect.appendChild(option);});
  decision.appendChild(decisionSelect);grid.appendChild(decision);
  var reason=el("label","wide",t("reason"));
  var reasonInput=el("input");reasonInput.name="reason";reason.appendChild(reasonInput);grid.appendChild(reason);
  form.appendChild(grid);
  var row=el("div","actions");
  var submit=el("button","button primary",t("sendReply"));submit.type="submit";row.appendChild(submit);form.appendChild(row);
  form.addEventListener("submit",function(event){event.preventDefault();void replyInteraction(select.value,decisionSelect.value,reasonInput.value);});
  return form;
}
function renderEventsInto(target,attempt){
  if(!target)return;
  target.replaceChildren();
  if(!state.eventsOpen)return;
  if(state.events.loading){target.appendChild(el("p","action-note",t("loadingEvents")));return;}
  if(state.events.error){target.appendChild(el("p","action-note blocked",state.events.error));return;}
  var rows=state.events.rows.filter(function(event){return event.attempt===attempt.attempt;}).sort(function(a,b){return Number(a.seq)-Number(b.seq);});
  target.appendChild(el("p","action-note",t("eventsCount",{n:rows.length})+(state.events.complete?" · "+t("eventsComplete"):"")));
  if(!rows.length){target.appendChild(el("p","action-note",t("eventsEmpty")));return;}
  var list=el("div","event-list");
  rows.forEach(function(event){
    var row=el("div","event-row");
    var top=el("div","event-top");
    top.appendChild(el("span","event-seq","#"+String(event.seq)));
    top.appendChild(el("span","event-type",event.type||"event"));
    top.appendChild(el("span","event-seq",formatDate(event.at)+(event.attempt?" · Attempt #"+String(event.attempt):"")));
    row.appendChild(top);
    row.appendChild(el("div","event-summary",event.summary||""));
    if(event.details&&Object.keys(event.details).length){
      var details=el("details","event-details");
      details.appendChild(el("summary","",t("showDetails")));
      var pre=el("pre","");pre.textContent=JSON.stringify(event.details,null,2);details.appendChild(pre);row.appendChild(details);
    }
    list.appendChild(row);
  });
  target.appendChild(list);
}
async function ensureEvents(force){
  var attempt=currentAttempt();if(!state.detail||!attempt)return;
  if(state.events.taskId!==state.detail.task_id){state.events={taskId:state.detail.task_id,rows:[],complete:false,loading:false,error:"",loaded:false};}
  if(state.events.loaded&&!force){var mount=document.getElementById("events-body");if(mount)renderEventsInto(mount,attempt);return;}
  if(state.events.loading)return;
  state.events.loading=true;state.events.error="";
  var currentMount=document.getElementById("events-body");if(currentMount)renderEventsInto(currentMount,attempt);
  var rows=[];var after=0;var complete=false;
  try{
    for(var pageIndex=0;pageIndex<500;pageIndex+=1){
      var path="/api/tasks/"+encodeURIComponent(state.detail.task_id)+"/events?limit=200&include_attempt=true&view=summary&max_bytes=33554432";
      if(after>0)path+="&after_seq="+String(after);
      var page=await api(path);
      if(Array.isArray(page.events))rows=rows.concat(page.events);
      if(!page.has_more){complete=true;break;}
      if(!Number.isSafeInteger(page.next_seq)||page.next_seq<=after)break;
      after=page.next_seq;
    }
    state.events.rows=rows;state.events.complete=complete;state.events.loaded=true;
  }catch(error){state.events.error=errorMessage(error);}
  finally{state.events.loading=false;}
  var mountNow=document.getElementById("events-body");
  if(mountNow&&state.eventsOpen&&state.detail&&state.selected)renderEventsInto(mountNow,currentAttempt()||attempt);
}
async function loadSession(){try{var session=await api("/api/session");state.csrf=session.csrf_token||"";state.session=session.executor||null;state.sessionLoaded=true;renderExecutor();return session;}catch(error){state.session=null;state.sessionLoaded=true;renderExecutor();throw error;}}
async function loadTasks(){
  try{
    var all=[];var after=null;
    for(var pageIndex=0;pageIndex<100;pageIndex+=1){
      var path="/api/tasks?limit=100";if(after)path+="&after_task_id="+encodeURIComponent(after);
      var page=await api(path);var rows=Array.isArray(page.tasks)?page.tasks:[];
      rows.forEach(function(task){if(task&&task.task_id)all.push(task);});
      if(!page.has_more||!page.next_task_id||page.next_task_id===after)break;
      after=page.next_task_id;
    }
    var seen={};state.tasks=all.filter(function(task){if(seen[task.task_id])return false;seen[task.task_id]=true;return true;});state.listError="";
  }catch(error){state.listError=t("refreshFailed")+" "+errorMessage(error);}
  renderList();
}
async function selectTask(id,updateUrl){
  if(!id||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(id)){setError(t("invalidTask"));return;}
  setError("");
  if(state.selected!==id){state.eventsOpen=false;state.technicalOpen=false;state.executionOpen=false;state.events={taskId:null,rows:[],complete:false,loading:false,error:"",loaded:false};state.selectedAttempt=null;state.actionForm=null;}
  state.selected=id;if(updateUrl)setTaskInLocation(id);renderList();await loadDetail();
  if(updateUrl&&window.matchMedia&&window.matchMedia("(max-width:980px)").matches){var panel=document.querySelector(".detail-panel");if(panel&&panel.scrollIntoView)panel.scrollIntoView({behavior:"smooth",block:"start"});}
}
async function loadDetail(){
  var id=state.selected;if(!id)return;
  try{
    var detail=await api("/api/tasks/"+encodeURIComponent(id)+"/console");
    if(state.selected!==id)return;
    state.detail=detail;state.detailError="";
    if(state.selectedAttempt===null||!detail.attempts.some(function(attempt){return attempt.attempt===state.selectedAttempt;}))state.selectedAttempt=detail.attempt;
    renderDetail();
  }catch(error){if(state.selected!==id)return;state.detail=null;state.detailError=t("detailFailed")+" "+errorMessage(error);renderDetail();}
}
function currentAttempt(){if(!state.detail)return null;return state.detail.attempts.find(function(attempt){return attempt.attempt===state.selectedAttempt;})||null;}
function canMutate(){return !state.busy&&state.selected&&state.detail;}
async function continueTask(feedback,requirements){
  if(!canMutate())return;state.busy=true;
  try{
    var list=String(requirements||"").split(/\r?\n/u).map(function(value){return value.trim();}).filter(Boolean);
    await api("/api/tasks/"+encodeURIComponent(state.selected)+"/continue",{method:"POST",csrf:true,body:JSON.stringify({feedback:String(feedback||"").trim(),additional_requirements:list})});
    state.actionForm=null;state.selectedAttempt=null;toast(t("taskActionDone"));await loadTasks();await loadDetail();
  }catch(error){toast(errorMessage(error),true);setError(errorMessage(error));}
  finally{state.busy=false;}
}
async function reworkTask(feedback){
  if(!canMutate())return;state.busy=true;
  try{
    await api("/api/tasks/"+encodeURIComponent(state.selected)+"/rework",{method:"POST",csrf:true,body:JSON.stringify({feedback:String(feedback||"").trim()})});
    state.actionForm=null;state.selectedAttempt=null;toast(t("taskActionDone"));await loadTasks();await loadDetail();
  }catch(error){toast(errorMessage(error),true);setError(errorMessage(error));}
  finally{state.busy=false;}
}
async function replyInteraction(requestId,decision,reason){
  if(!canMutate())return;state.busy=true;
  try{
    await api("/api/tasks/"+encodeURIComponent(state.selected)+"/reply",{method:"POST",csrf:true,body:JSON.stringify({request_id:requestId,decision:decision,...(reason?{reason:String(reason)}:{})})});
    state.selectedAttempt=null;toast(t("taskActionDone"));await loadTasks();await loadDetail();if(state.eventsOpen)await ensureEvents(true);
  }catch(error){toast(errorMessage(error),true);setError(errorMessage(error));}
  finally{state.busy=false;}
}
async function cancelTask(){
  if(!canMutate())return;if(!window.confirm(t("cancelConfirm")))return;state.busy=true;
  try{
    await api("/api/tasks/"+encodeURIComponent(state.selected)+"/cancel",{method:"POST",csrf:true,body:"{}"});
    state.selectedAttempt=null;toast(t("taskActionDone"));await loadTasks();await loadDetail();if(state.eventsOpen)await ensureEvents(true);
  }catch(error){toast(errorMessage(error),true);setError(errorMessage(error));}
  finally{state.busy=false;}
}
async function recoverCleanup(){
  if(!canMutate())return;if(!window.confirm(t("cleanupRecoveryConfirm")))return;state.busy=true;
  try{
    await api("/api/tasks/"+encodeURIComponent(state.selected)+"/recover-cleanup",{method:"POST",csrf:true,body:JSON.stringify({release_mode:"zcode_cancel_administrative_release"})});
    state.selectedAttempt=null;toast(t("taskActionDone"));await loadTasks();await loadDetail();if(state.eventsOpen)await ensureEvents(true);
  }catch(error){var message=friendlyError(error);toast(message,true);setError(message);}
  finally{state.busy=false;}
}
async function refreshAll(forceEvents){
  state.busy=true;
  try{await Promise.all([loadTasks(),state.selected?loadDetail():Promise.resolve()]);if(forceEvents&&state.eventsOpen)await ensureEvents(true);}
  finally{state.busy=false;}
}
function diagOutput(value){state.diagOutput=typeof value==="string"?value:JSON.stringify(value,null,2);var node=$("#diag-output");if(node)node.textContent=state.diagOutput;}
function diagError(error){diagOutput((error&&error.code?error.code+": ":"")+errorMessage(error));toast(errorMessage(error),true);}
async function openDiagnostics(){
  var dialog=$("#diagnostics");if(!dialog)return;
  if(!state.settingsLoaded){
    try{
      var settings=await api("/api/settings");state.settings=settings;state.settingsLoaded=true;
      var checkbox=$("#auto-wake");if(checkbox)checkbox.checked=Boolean(settings.auto_wake&&settings.auto_wake.enabled);
      diagOutput(t("settingsLoaded"));
    }catch(error){diagError(error);}
  }
  if(typeof dialog.showModal==="function")dialog.showModal();else dialog.setAttribute("open","");
}
async function saveAutoWake(){
  try{
    var checkbox=$("#auto-wake");
    var result=await api("/api/settings/auto-wake",{method:"POST",csrf:true,body:JSON.stringify({enabled:Boolean(checkbox.checked)})});
    state.settings=result;state.settingsLoaded=true;diagOutput(t("settingsSaved")+"\n"+JSON.stringify(result,null,2));toast(t("settingsSaved"));
  }catch(error){diagError(error);}
}
async function inspectRuntime(mode){
  try{
    var result;
    if(mode==="check")result=await api("/api/runtime/check",{method:"POST",csrf:true,body:"{}"});
    else if(mode==="probe")result=await api("/api/runtime/protocol-probe",{method:"POST",csrf:true,body:"{}"});
    else result=await api("/api/runtime");
    diagOutput(result);toast(mode==="probe"?t("protocolProbe"):t("inspectRuntime"));
  }catch(error){diagError(error);}
}
async function exportRuntimeReport(){
  try{
    var report=await api("/api/runtime/candidate");diagOutput(report);
    var blob=new Blob([JSON.stringify(report,null,2)+"\n"],{type:"application/json"});
    var url=URL.createObjectURL(blob);var anchor=document.createElement("a");
    anchor.href=url;anchor.download="runtime-compatibility-candidate.json";
    document.body.appendChild(anchor);anchor.click();anchor.remove();
    setTimeout(function(){URL.revokeObjectURL(url);},1000);toast(t("reportReady"));
  }catch(error){diagError(error);}
}
async function costDiagnostic(mode){
  try{
    var path=mode==="history"?"/api/cost-lab/history":mode==="verification"?"/api/cost-lab/session":"/api/cost-lab/environment";
    var result=await api(path);diagOutput(result);
    toast(mode==="history"?t("costHistoryLoaded"):mode==="verification"?t("verificationLoaded"):t("costEnvironmentLoaded"));
  }catch(error){diagError(error);}
}
function bindUi(){
  var language=$("#language");var theme=$("#theme");
  language.value=state.lang;theme.value=state.theme;
  language.addEventListener("change",function(){state.lang=language.value;applyLanguage();});
  theme.addEventListener("change",function(){state.theme=theme.value;applyTheme();});
  $("#refresh-tasks").addEventListener("click",function(){void refreshAll(false);});
  var search=$("#task-search");if(search)search.addEventListener("input",function(){state.query=search.value||"";renderList();});
  var bucket=$("#bucket-filter");if(bucket)bucket.addEventListener("change",function(){state.filter=bucket.value||null;renderList();});
  document.querySelectorAll(".summary-item").forEach(function(button){
    button.addEventListener("click",function(){
      var value=button.getAttribute("data-filter");
      state.filter=state.filter===value?null:value;
      renderList();
      if(state.selected)void loadDetail();
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
async function bootstrap(){
  try{var savedTheme=localStorage.getItem("bridge.ui.theme");if(savedTheme==="light"||savedTheme==="dark"||savedTheme==="system")state.theme=savedTheme;}catch(_ignore){}
  try{var savedLang=localStorage.getItem("bridge.ui.language");if(savedLang==="en"||savedLang==="zh-CN")state.lang=savedLang;else if(navigator.language&&navigator.language.indexOf("zh")===0)state.lang="zh-CN";}catch(_ignore){}
  applyTheme();bindUi();applyLanguage();
  try{await loadSession();}catch(error){setError(t("sessionOffline")+" "+errorMessage(error));}
  await loadTasks();
  var deep=taskIdFromLocation();
  if(deep){await selectTask(deep,false);}
  else if(state.tasks.length){var preferred=state.tasks.find(function(task){return task.needs_attention;})||state.tasks[0];await selectTask(preferred.task_id,false);}
  state.refreshTimer=setInterval(function(){if(document.visibilityState==="visible")void refreshAll(false);},10000);
}
document.addEventListener("DOMContentLoaded",function(){void bootstrap();});
})();
</script>
</body>
</html>`;
}
