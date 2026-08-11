#!/usr/bin/env node
/**
 * 브릿지원 데이터매니저 — AI 원인분석 코멘트 생성 스크립트
 * ------------------------------------------------------------
 * 대시보드(v01_improved.html)의 buildDatasets() / 오늘의 브리핑 하이라이트 로직을
 * 서버(Node.js) 환경으로 그대로 이식하여, 매일 자동으로:
 *   1) 구글 스프레드시트에서 원본 데이터를 읽고
 *   2) 대시보드와 동일한 규칙으로 "변동 신호(하이라이트)"를 계산한 뒤
 *   3) 그 신호만 근거로 Claude API에 자연어 코멘트를 요청하고
 *   4) 결과를 data/latest-insight.json 으로 저장(커밋)합니다.
 *
 * 이 스크립트는 "숫자를 창작"하지 않습니다 — Claude에게 넘기는 것은 이미 계산된
 * 하이라이트 텍스트뿐이며, 프롬프트에도 "주어진 신호 밖의 내용은 추측하지 말 것"을
 * 명시합니다.
 *
 * [v2 확장] 대시보드의 "구성 · 순위" / "원자료 표" 탭 상단 종합 세션(compositionGlance /
 * rawdataGlance)을 위해, 위 1)~4)와 동일한 안전장치로 "이번 달 vs 전월" 단위의 변동
 * 신호도 함께 계산해 composition_commentary / rawdata_commentary로 저장합니다.
 * (신호가 하나도 없으면 해당 탭의 API 호출은 생략합니다 — 비용 절감.)
 *
 * [v3 확장] Claude 외에 Gemini API도 선택해서 쓸 수 있습니다 — 신호 계산 로직·안전장치는
 * 완전히 동일하고, "어느 회사의 LLM에 신호 텍스트를 보내 코멘트를 받을지"만 바뀝니다.
 * AI_PROVIDER 환경변수로 전환하며(코드 수정 불필요), 언제든 다시 되돌릴 수 있습니다.
 *
 * [v4 개선] "월초 착시" 방지 — 이번 달이 진행 중이면 전월도 같은 날짜까지만 잘라 비교합니다.
 *
 * [v5 확장] "추세 분석" 탭 상단 종합 세션을 위해, "주요 대분류 · 주차별(최근 N주 vs 직전
 * N주)" 고정 기준으로도 변동 신호를 계산해 trend_commentary로 저장합니다. 이 탭은 사용자가
 * 화면에서 필터를 바꿔가며 보는 탐색형 화면이라, 어떤 필터가 선택돼 있든 항상 같은 고정
 * 기준으로만 신호를 계산합니다(안전장치는 v2와 동일). "월초 착시"와 같은 원리로 아직 끝나지
 * 않은 이번 주는 비교에서 제외합니다("주초 착시" 방지).
 *
 * [v6 확장 — 2026-08-10] "오늘의 브리핑" 탭의 규칙 기반 "권장 조치"(ACTION_MAP)는 대시보드가
 * 열릴 때 즉시·무료로 계산되는 정적 문구라 "점검 필요"처럼 막연합니다. 이를 보강하기 위해,
 * 오늘의 브리핑 상위 신호(최대 3건, 비용 통제용)에 대해서만 웹 검색 기능을 켠 AI 호출을
 * 추가로 1회 실행해 더 구체적인 "웹 검색 기반 대응 방안"을 만들고, highlight_actions_ai로
 * 저장합니다. 신호 자체(사실관계)는 여전히 위에서 이미 계산된 것만 사용하며, "대응 방안"에
 * 한해서만 웹 검색 결과 반영을 허용합니다 — 반드시 참고 출처와 함께. 웹 검색 호출이 실패하거나
 * 응답 파싱이 안 되면 이 보강 없이 조용히 건너뛰며(빈 배열), 기존 규칙 기반 권장 조치·오늘의
 * 브리핑 코멘트에는 전혀 영향이 없습니다.
 *
 * [v6.1 수정 — 2026-08-11] Gemini의 "웹 검색(Grounding with Google Search)" 기능은 결제
 * 미등록 무료 API 키에서는 대부분 모델에서 아예 사용 불가하며, 예외적으로 gemini-2.5-flash /
 * gemini-2.5-flash-lite 두 모델만 결제 없이 하루 500건까지 무료로 지원됩니다. 기존에는
 * 일반 코멘트 생성과 동일하게 GEMINI_MODEL(기본값 gemini-3.5-flash-lite)을 웹 검색 호출에도
 * 그대로 썼는데, 이 모델은 무료 예외 대상이 아니라서 결제 미등록 키에서는 429(할당량 초과)
 * 오류로 항상 실패했습니다. 이를 고치기 위해 "웹 검색 호출 전용" 모델을 별도로
 * GEMINI_SEARCH_MODEL(기본값 gemini-2.5-flash-lite)로 분리했습니다 — 일반 코멘트 생성
 * 모델(GEMINI_MODEL)은 그대로 두고, 웹 검색 호출에만 무료 등급이 지원되는 모델을 씁니다.
 *
 * 필요 환경변수: AI_PROVIDER=claude 인 경우 ANTHROPIC_API_KEY,
 *              AI_PROVIDER=gemini 인 경우 GEMINI_API_KEY (둘 다 GitHub Repository Secret으로 등록)
 * 선택 환경변수: AI_PROVIDER (기본값 gemini — 'claude' 또는 'gemini')
 *              CLAUDE_MODEL (AI_PROVIDER=claude일 때, 기본값 claude-haiku-4-5)
 *              GEMINI_MODEL (AI_PROVIDER=gemini일 때, 기본값 gemini-3.5-flash-lite — 가장 저렴한 모델)
 *              GEMINI_SEARCH_MODEL (AI_PROVIDER=gemini일 때 "웹 검색 호출" 전용, 기본값
 *                gemini-2.5-flash-lite — 결제 미등록 키도 하루 500건까지 무료로 웹 검색 가능)
 * 실행 방법:     node scripts/generate-insight.js
 * 실행 환경:     Node.js 18 이상 (내장 fetch 사용, 별도 설치 불필요)
 */
 
const fs = require('fs');
const path = require('path');
 
// ---------------------------------------------------------------------------
// 0. 설정값 — 대시보드(v01_improved.html)와 동일한 시트 ID/GID를 그대로 사용합니다.
// ---------------------------------------------------------------------------
const SHEET_ID = '1uYftf05-dZ0VS3tPzvEV-G0fukcc8QFShXkbKMzRQ4U';
const DATA_GID = '0';
const PATENT_GID = '401781610';
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'latest-insight.json');
 
// AI_PROVIDER: 'claude' 또는 'gemini' — 기본값은 gemini(현재 등록된 키 기준).
// 나중에 Anthropic 키를 등록하고 AI_PROVIDER=claude로만 바꾸면 코드 수정 없이 Claude로 전환됩니다.
const AI_PROVIDER = (process.env.AI_PROVIDER || 'gemini').trim().toLowerCase();
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
// [v6.1] 웹 검색(Grounding) 호출 전용 모델 — 결제 미등록 키도 무료로 웹 검색이 가능한 모델을 기본값으로 사용합니다.
const GEMINI_SEARCH_MODEL = process.env.GEMINI_SEARCH_MODEL || 'gemini-2.5-flash-lite';
const MODEL = AI_PROVIDER === 'claude' ? CLAUDE_MODEL : GEMINI_MODEL;
const SEARCH_MODEL = AI_PROVIDER === 'claude' ? CLAUDE_MODEL : GEMINI_SEARCH_MODEL;
 
// ---------------------------------------------------------------------------
// 1. 시트 데이터 가져오기 (gviz CSV export) + CSV 파서
// ---------------------------------------------------------------------------
async function fetchCsv(gid) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?gid=${gid}&tqx=out:csv`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`시트 CSV 다운로드 실패 (gid=${gid}): HTTP ${res.status}`);
  return await res.text();
}
 
// RFC4180 스타일 CSV 파서 — 큰따옴표로 감싼 필드, 필드 내 콤마/줄바꿈, ""로 이스케이프된 따옴표를 처리합니다.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  // 끝에 빈 줄이 남는 경우 제거
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}
 
// ---------------------------------------------------------------------------
// 2. 대시보드와 동일한 집계 로직 (buildDatasets 이식)
// ---------------------------------------------------------------------------
function normalizeCompanyName(raw) {
  if (!raw) return '';
  let name = raw.split('/')[0].trim();
  name = name.replace(/^\(주\)\s*/, '').replace(/㈜\s*/g, '').replace(/^주식회사\s*/, '').trim();
  return name;
}
function isJunkCompanyName(name) {
  if (!name) return true;
  if (name.includes('?') || name.includes('오류')) return true;
  return false;
}
// 대시보드(v01_improved.html)의 josa() 이식 — 한글 받침 유무에 따른 주격조사(이/가) 자동 선택
function josa(word, pair) {
  if (!word) return pair[1];
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xAC00 || code > 0xD7A3) return pair[1];
  const hasBatchim = (code - 0xAC00) % 28 !== 0;
  return hasBatchim ? pair[0] : pair[1];
}
 
const RAW_CATS = ['POUR', '다특허', '다특허(PD)', 'DO', 'CNC', '일반', '타사'];
const MAIN_CATS = ['POUR', '다특허', 'DO', 'CNC', '일반', '타사'];
const TOP_COMPANY_COUNT = 8;
const EMERGING_COMPANY_COUNT = 5;
const ETC_LABEL = '기타 (그 외 군소·미분류)';
const METHOD_TYPE_COLS = ['옥상방수', '재도장', '주차장', '도로', '기타'];
const METHOD_TYPE_UNCLASSIFIED = '미분류';
const TREND_WORKTYPES = METHOD_TYPE_COLS.concat(METHOD_TYPE_UNCLASSIFIED);
 
function buildDatasets(patentRows, mainRows) {
  const patentMap = new Map();
  patentRows.slice(1).forEach(r => {
    const patentNo = (r[0] || '').trim();
    const name = normalizeCompanyName(r[1] || '');
    if (!patentNo || isJunkCompanyName(name)) return;
    patentMap.set(patentNo, name);
  });
 
  const header = mainRows[0];
  const idx = name => header.indexOf(name);
  const iCat = idx('구분'), iDate = idx('공고일'), iPatent = idx('특허번호');
  const iMethodCols = METHOD_TYPE_COLS.map(name => idx(name));
 
  const dailyMapBuild = {};
  const companyDailyBuild = {};
  const companyTotals = {};
  const companyMonthly = {};
  const monthSet = new Set();
  let pdTotal = 0;
  const methodDailyBuild = {};
  function methodDailyBucket(date, methodType) {
    if (!methodDailyBuild[date]) methodDailyBuild[date] = {};
    if (!methodDailyBuild[date][methodType]) methodDailyBuild[date][methodType] = { pour: 0, companies: {} };
    return methodDailyBuild[date][methodType];
  }
 
  mainRows.slice(1).forEach(r => {
    if (!r || r.length < 2) return;
    const date = (r[iDate] || '').trim();
    const cat = (r[iCat] || '').trim();
    if (!date || !RAW_CATS.includes(cat)) return;
    if (!dailyMapBuild[date]) dailyMapBuild[date] = {};
    dailyMapBuild[date][cat] = (dailyMapBuild[date][cat] || 0) + 1;
    if (cat === '다특허(PD)') pdTotal++;
 
    const isPourGroup = (cat === 'POUR' || cat === '다특허(PD)');
    let methodType = METHOD_TYPE_UNCLASSIFIED;
    if (isPourGroup || cat === '타사') {
      for (let mi = 0; mi < iMethodCols.length; mi++) {
        if (iMethodCols[mi] >= 0 && (r[iMethodCols[mi]] || '').trim()) { methodType = METHOD_TYPE_COLS[mi]; break; }
      }
      if (isPourGroup) methodDailyBucket(date, methodType).pour++;
    }
 
    if (cat === '타사') {
      const patentRaw = (r[iPatent] || '').trim();
      const firstPatent = patentRaw.split(/\s+/)[0];
      const companyName = patentMap.get(firstPatent) || ETC_LABEL;
 
      if (!companyDailyBuild[date]) companyDailyBuild[date] = {};
      companyDailyBuild[date][companyName] = (companyDailyBuild[date][companyName] || 0) + 1;
 
      companyTotals[companyName] = (companyTotals[companyName] || 0) + 1;
      const ym = date.slice(0, 7);
      monthSet.add(ym);
      if (!companyMonthly[companyName]) companyMonthly[companyName] = {};
      companyMonthly[companyName][ym] = (companyMonthly[companyName][ym] || 0) + 1;
 
      const mBucket = methodDailyBucket(date, methodType);
      mBucket.companies[companyName] = (mBucket.companies[companyName] || 0) + 1;
    }
  });
 
  const dates = Object.keys(dailyMapBuild).sort();
  const dateMin = dates[0], dateMax = dates[dates.length - 1];
 
  const daily = dates.map(date => {
    const rec = { date };
    const raw = dailyMapBuild[date];
    let total = 0;
    RAW_CATS.forEach(c => { total += (raw[c] || 0); });
    MAIN_CATS.forEach(c => { rec[c] = raw[c] || 0; });
    rec['POUR'] += raw['다특허(PD)'] || 0;
    rec.total = total;
    return rec;
  });
 
  const months = [...monthSet].sort();
  const sortedCompanies = Object.entries(companyTotals)
    .filter(([name]) => name !== ETC_LABEL)
    .sort((a, b) => b[1] - a[1]);
 
  const topCompanies = sortedCompanies.slice(0, TOP_COMPANY_COUNT);
  const restCompanies = sortedCompanies.slice(TOP_COMPANY_COUNT);
  const etcTotal = restCompanies.reduce((s, [, v]) => s + v, 0) + (companyTotals[ETC_LABEL] || 0);
 
  function monthlyArrayFor(name) {
    const m = companyMonthly[name] || {};
    return months.map(ym => m[ym] || 0);
  }
 
  const companies = topCompanies.map(([name, total]) => ({ name, total, monthly: monthlyArrayFor(name) }));
  const etcMonthly = months.map(ym => {
    let v = (companyMonthly[ETC_LABEL] && companyMonthly[ETC_LABEL][ym]) || 0;
    restCompanies.forEach(([name]) => { v += (companyMonthly[name] && companyMonthly[name][ym]) || 0; });
    return v;
  });
  companies.push({ name: ETC_LABEL, total: etcTotal, monthly: etcMonthly });
 
  const etcFloor = topCompanies.length ? topCompanies[topCompanies.length - 1][1] * 0.5 : 0;
  const emergingCompanies = restCompanies
    .filter(([, total]) => total >= etcFloor)
    .slice(0, EMERGING_COMPANY_COUNT)
    .map(([name, total]) => ({ name, total, monthly: monthlyArrayFor(name) }));
 
  const totalCompetitor = Object.values(companyTotals).reduce((s, v) => s + v, 0);
 
  const DATA = { daily, date_min: dateMin, date_max: dateMax, categories: MAIN_CATS, pd_total: pdTotal };
  const COMPETITOR_DATA = {
    months, companies, emerging_companies: emergingCompanies,
    total_competitor: totalCompetitor,
    unmatched_count: companyTotals[ETC_LABEL] || 0,
    total_unique_companies: Object.keys(companyTotals).length,
  };
 
  // 대시보드와 동일하게 일자별 레코드에 업체별 건수를 병합
  const COMPANY_NAMES = COMPETITOR_DATA.companies.map(c => c.name);
  DATA.daily.forEach(d => {
    const dayComp = companyDailyBuild[d.date] || {};
    COMPANY_NAMES.forEach(name => { d[name] = dayComp[name] || 0; });
  });
 
  // 공종별 일자 합계 (오늘의 브리핑 하이라이트용) — METHOD_DAILY를 DATA.daily와 같은 형태로 변환
  const worktypeDailyMap = {};
  DATA.daily.forEach(d => {
    const rec = {};
    const buckets = methodDailyBuild[d.date] || {};
    TREND_WORKTYPES.forEach(type => {
      const b = buckets[type];
      rec[type] = b ? (b.pour + Object.values(b.companies).reduce((s, v) => s + v, 0)) : 0;
    });
    worktypeDailyMap[d.date] = rec;
  });
 
  const dailyMap = {};
  DATA.daily.forEach(d => { dailyMap[d.date] = d; });
 
  return { DATA, COMPETITOR_DATA, COMPANY_DAILY: companyDailyBuild, dailyMap, worktypeDailyMap, COMPANY_NAMES };
}
 
// ---------------------------------------------------------------------------
// 3. 오늘의 브리핑 하이라이트 로직 이식 (renderBriefing의 규칙 부분만 — 화면 렌더링 제외)
// ---------------------------------------------------------------------------
const ACTION_MAP = {
  'worktype-new': '신규 발생 배경 확인, 지속 여부 모니터링',
  'worktype-up': '해당 공종 영업자료·견적 준비 강화 검토',
  'worktype-down': '원인(계절성·경쟁 등) 점검, 필요 시 해당 공종 마케팅 활동 점검',
  'company-new': '신규 등장 배경 확인 필요',
  'company-up': '해당 업체 동향 확인, 견적·영업 대응 전략 검토',
  'company-down': '특이 조치 불필요, 지속 모니터링',
  'pour_share-up': '긍정적 신호 — 현재 영업 전략 유지',
  'pour_share-down': '점유율 하락 원인 점검 및 영업팀 공유 필요',
  'pour_dry_spell-alert': '영업팀 즉시 확인, 파이프라인(진행 중 견적·현장) 점검 최우선',
  'emerging-new': '신규 진입 업체 특허·이력 확인, 요주의 리스트 등록 검토',
  'emerging-up': '성장 추세 지속 모니터링, 상위 8개사 구도 재편 가능성 대비',
  'emerging-down': '특이 조치 불필요, 지속 모니터링',
  // --- 월간(전월 대비) 신호 — 구성 · 순위 / 원자료 표 탭 종합 세션용 ---
  'monthly_total-up': '월간 물량 증가 대응 — 인력·자원 배분 점검',
  'monthly_total-down': '월간 물량 감소 원인 점검, 영업 파이프라인 보강 검토',
  'category-up': '해당 구분 비중 확대 배경 확인, 관련 영업자료 보강 검토',
  'category-down': '해당 구분 비중 축소 원인 점검',
  'pour_share_m-up': '긍정적 신호 — 현재 영업 전략 유지',
  'pour_share_m-down': '월간 점유율 하락 원인 점검 및 영업팀 공유 필요',
  'worktype_m-new': '신규 공종 발생 배경 확인, 지속 여부 모니터링',
  'worktype_m-up': '해당 공종 월간 수요 증가 — 영업자료·견적 준비 강화 검토',
  'worktype_m-down': '해당 공종 월간 수요 감소 원인 점검',
  'company_m-new': '월간 신규 등장 업체 배경 확인 필요',
  'company_m-up': '해당 업체 월간 증가 동향 확인, 견적·영업 대응 전략 검토',
  'company_m-down': '특이 조치 불필요, 지속 모니터링',
  'top_competitor-changed': '1위 업체 변동 배경 확인, 경쟁 구도 변화 대비',
  // --- 추세 분석 탭 종합 세션용 (주요 대분류 · 주차별, 최근 N주 vs 직전 N주) ---
  'trend_cat-new': '신규 발생 배경 확인, 최근 몇 주 추세 지속 여부 모니터링',
  'trend_cat-up': '해당 구분 최근 주간 증가 추세 — 영업자료·인력 배분 점검',
  'trend_cat-down': '해당 구분 최근 주간 감소 추세 원인 점검',
};
function actionFor(h) { return ACTION_MAP[`${h.type}-${h.direction}`] || null; }
 
function computeHighlights(ds) {
  const { DATA, COMPETITOR_DATA, COMPANY_DAILY, dailyMap, worktypeDailyMap, COMPANY_NAMES } = ds;
  const allDatesSorted = DATA.daily.map(d => d.date).sort();
  const latestDate = allDatesSorted[allDatesSorted.length - 1];
  function shiftDate(dateStr, days) { const d = new Date(dateStr); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
  function lastNDates(endDate, n) { const res = []; let d = new Date(endDate); for (let i = 0; i < n; i++) { res.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() - 1); } return res.reverse(); }
  const recent7 = lastNDates(latestDate, 7);
  const prev7 = lastNDates(shiftDate(latestDate, -7), 7);
 
  function sumField(dates, field) { return dates.reduce((s, dt) => s + ((dailyMap[dt] && dailyMap[dt][field]) || 0), 0); }
  function sumWorktype(dates, type) { return dates.reduce((s, dt) => s + ((worktypeDailyMap[dt] && worktypeDailyMap[dt][type]) || 0), 0); }
 
  const totalRecent = sumField(recent7, 'total'), totalPrev = sumField(prev7, 'total');
  const pourRecent = sumField(recent7, 'POUR'), pourPrev = sumField(prev7, 'POUR');
  const pourShareRecent = totalRecent ? (pourRecent / totalRecent * 100) : 0;
  const pourSharePrev = totalPrev ? (pourPrev / totalPrev * 100) : 0;
  const shareDiff = pourShareRecent - pourSharePrev;
 
  const THRESH_PCT = 20;
  const MIN_BASE = 3;
  const highlights = [];
 
  TREND_WORKTYPES.forEach(type => {
    const r = sumWorktype(recent7, type), p = sumWorktype(prev7, type);
    if (p === 0) { if (r >= 3) highlights.push({ text: `${type} 공종에서 최근 7일 새로 ${r}건이 발생했습니다 (직전 7일 0건).`, score: 60, type: 'worktype', subject: type, direction: 'new' }); return; }
    if (p < MIN_BASE) return;
    const pct = (r - p) / p * 100;
    if (Math.abs(pct) >= THRESH_PCT) highlights.push({ text: `${type} 공종이 직전 7일 ${p}건 → 최근 7일 ${r}건으로 ${pct > 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(0)}% ${pct > 0 ? '증가' : '감소'}했습니다.`, score: Math.abs(pct), type: 'worktype', subject: type, direction: pct > 0 ? 'up' : 'down', pct });
  });
 
  COMPANY_NAMES.forEach(name => {
    if (name.startsWith('기타')) return;
    const r = sumField(recent7, name), p = sumField(prev7, name);
    if (p === 0) { if (r >= 3) highlights.push({ text: `${name}이(가) 최근 7일간 새로 ${r}건 등장했습니다 (직전 7일 0건) — 확인이 필요할 수 있습니다.`, score: 65, type: 'company', subject: name, direction: 'new' }); return; }
    if (p < MIN_BASE) return;
    const pct = (r - p) / p * 100;
    if (Math.abs(pct) >= THRESH_PCT) highlights.push({ text: `${name}이(가) 직전 7일 ${p}건 → 최근 7일 ${r}건으로 ${pct > 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(0)}% ${pct > 0 ? '증가' : '감소'}했습니다.`, score: Math.abs(pct), type: 'company', subject: name, direction: pct > 0 ? 'up' : 'down', pct });
  });
 
  if (totalPrev >= MIN_BASE && Math.abs(shareDiff) >= 3) {
    highlights.push({ text: `전체 공고 중 POUR 비중이 직전 7일 ${pourSharePrev.toFixed(1)}% → 최근 7일 ${pourShareRecent.toFixed(1)}%로 ${shareDiff > 0 ? '▲' : '▼'}${Math.abs(shareDiff).toFixed(1)}%p ${shareDiff > 0 ? '상승' : '하락'}했습니다.`, score: Math.abs(shareDiff) * 8, type: 'pour_share', direction: shareDiff > 0 ? 'up' : 'down', magnitude: shareDiff });
  }
 
  let pourDrySpell = 0;
  {
    let d = latestDate;
    while (pourDrySpell < 90 && d >= DATA.date_min) {
      const rec = dailyMap[d];
      const pourCount = rec ? (rec['POUR'] || 0) : 0;
      if (pourCount > 0) break;
      pourDrySpell++;
      d = shiftDate(d, -1);
    }
  }
  if (pourDrySpell >= 3) {
    highlights.push({ text: `⚠ POUR 관련 공고가 ${pourDrySpell}일 연속 0건입니다 (최신 데이터 기준일 ${latestDate}까지).`, score: 200, type: 'pour_dry_spell', direction: 'alert', days: pourDrySpell });
  }
 
  (COMPETITOR_DATA.emerging_companies || []).forEach(c => {
    const rEm = recent7.reduce((s, dt) => s + ((COMPANY_DAILY[dt] && COMPANY_DAILY[dt][c.name]) || 0), 0);
    const pEm = prev7.reduce((s, dt) => s + ((COMPANY_DAILY[dt] && COMPANY_DAILY[dt][c.name]) || 0), 0);
    if (pEm === 0) { if (rEm >= 3) highlights.push({ text: `🆕 신흥 업체 ${c.name}이(가) 최근 7일간 새로 ${rEm}건 등장했습니다 (직전 7일 0건, 주요 8개사 밖 요주의 업체).`, score: 70, type: 'emerging', subject: c.name, direction: 'new' }); return; }
    if (pEm < MIN_BASE) return;
    const pct = (rEm - pEm) / pEm * 100;
    if (Math.abs(pct) >= THRESH_PCT) highlights.push({ text: `🆕 신흥 업체 ${c.name}이(가) 직전 7일 ${pEm}건 → 최근 7일 ${rEm}건으로 ${pct > 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(0)}% ${pct > 0 ? '증가' : '감소'}했습니다 (주요 8개사 밖 요주의 업체).`, score: Math.abs(pct) + 5, type: 'emerging', subject: c.name, direction: pct > 0 ? 'up' : 'down', pct });
  });
 
  highlights.sort((a, b) => b.score - a.score);
 
  return {
    highlights, latestDate, recent7, prev7,
    totalRecent, totalPrev, pourRecent, pourPrev,
    pourShareRecent, pourSharePrev, shareDiff, pourDrySpell,
  };
}
 
// ---------------------------------------------------------------------------
// 3a-2. "추세 분석" 탭 종합 세션용 — 주요 대분류 · 주차별(최근 N주 vs 직전 N주) 신호 계산
//     대시보드 "추세 분석" 탭은 일별/주별/월별·표시 항목·업체/공종 필터를 사용자가 그때그때
//     바꿔가며 보는 탐색형 화면이라, 매일 새벽 한 번 생성되는 AI 소견은 "주요 대분류(POUR/
//     다특허/DO/CNC/일반/타사) · 주차별" 고정 기준으로만 계산합니다(사용자가 화면에서 어떤
//     필터를 선택했는지와 무관하게 항상 같은 기준).
//
// ⚠ "주초 착시" 방지: 대시보드의 주차 구분(월요일 시작)과 동일하게 주 단위로 묶되, 아직
// 끝나지 않은 이번 주(일요일 데이터가 없는 주)는 비교에서 제외합니다 — 월간 신호의 "월초
// 착시" 방지와 같은 이유입니다.
// ---------------------------------------------------------------------------
const WEEKLY_THRESH_PCT = 20;
const WEEKLY_MIN_BASE = 5;
const WEEKLY_MAX_SPAN = 4;
 
function weekMondayStr(dateStr) {
  const dt = new Date(dateStr);
  const monday = new Date(dt);
  monday.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}
function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
 
function computeTrendWeeklySignals(ds) {
  const { dailyMap, DATA } = ds;
  const allDates = Object.keys(dailyMap).sort();
  if (allDates.length === 0) return { hasEnoughData: false, highlights: [] };
 
  const latestDate = DATA.date_max;
  const weekSums = {};
  allDates.forEach(date => {
    const wk = weekMondayStr(date);
    if (!weekSums[wk]) { weekSums[wk] = {}; MAIN_CATS.forEach(c => { weekSums[wk][c] = 0; }); }
    const rec = dailyMap[date];
    MAIN_CATS.forEach(c => { weekSums[wk][c] += (rec[c] || 0); });
  });
  let weeks = Object.keys(weekSums).sort();
 
  // 마지막 주의 일요일이 아직 최신 데이터 기준일보다 뒤라면(=이번 주가 진행 중이라면) 비교에서 제외.
  let comparisonNote = null;
  if (weeks.length) {
    const lastWeek = weeks[weeks.length - 1];
    const lastWeekSunday = addDays(lastWeek, 6);
    if (lastWeekSunday > latestDate) {
      weeks = weeks.slice(0, -1);
      comparisonNote = `이번 주는 아직 진행 중이라 완결된 최근 주 단위로만 비교했습니다(최신 데이터 기준일 ${latestDate}).`;
    }
  }
 
  if (weeks.length < 2) return { hasEnoughData: false, highlights: [], comparisonNote };
 
  const span = Math.max(1, Math.min(WEEKLY_MAX_SPAN, Math.floor(weeks.length / 2)));
  const recentWeeks = weeks.slice(weeks.length - span);
  const prevWeeks = weeks.slice(Math.max(0, weeks.length - 2 * span), weeks.length - span);
 
  function sumCat(weekList, cat) {
    return weekList.reduce((s, wk) => s + (weekSums[wk][cat] || 0), 0);
  }
 
  const highlights = [];
  MAIN_CATS.forEach(cat => {
    const r = sumCat(recentWeeks, cat), p = sumCat(prevWeeks, cat);
    if (p === 0) {
      if (r >= WEEKLY_MIN_BASE) highlights.push({ text: `${cat} 공고가 최근 ${span}주 새로 ${r}건 발생했습니다 (직전 ${span}주 0건).`, score: 55, type: 'trend_cat', subject: cat, direction: 'new' });
      return;
    }
    if (p < WEEKLY_MIN_BASE) return;
    const pct = (r - p) / p * 100;
    if (Math.abs(pct) >= WEEKLY_THRESH_PCT) highlights.push({ text: `${cat} 공고가 직전 ${span}주 ${p}건 → 최근 ${span}주 ${r}건으로 ${pct > 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(0)}% ${pct > 0 ? '증가' : '감소'}했습니다.`, score: Math.abs(pct), type: 'trend_cat', subject: cat, direction: pct > 0 ? 'up' : 'down', pct });
  });
 
  highlights.sort((a, b) => b.score - a.score);
 
  return { hasEnoughData: true, span, recentWeeks, prevWeeks, comparisonNote, highlights };
}
 
// ---------------------------------------------------------------------------
// 3b. 월간(전월 대비) 변동 신호 계산 — "구성 · 순위" / "원자료 표" 탭 종합 세션용
//     대시보드의 compositionGlance / rawdataGlance와 같은 관점(이번 달 vs 전월)으로,
//     같은 방식(규칙 기반 신호 → AI에 신호만 근거로 전달)을 월간 단위로 이식한 것입니다.
//
// ⚠ "월초 착시" 방지: 이번 달이 아직 진행 중(예: 8/6까지만 데이터가 있음)인데 전월
// "한 달 전체"와 그대로 비교하면, 실제로는 아무 이상이 없어도 매달 초마다 "전월 대비
// 80%↓" 식으로 과장된 감소처럼 보입니다(단순히 날짜 수가 다르기 때문). 이를 막기 위해
// 이번 달이 미완결이면 전월도 "같은 날짜까지"만 잘라서 공정하게 비교합니다.
// ---------------------------------------------------------------------------
const MONTHLY_THRESH_PCT = 15;
const MONTHLY_MIN_BASE = 5;
 
function monthKey(dateStr) { return dateStr.slice(0, 7); }
 
function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate(); // 다음 달 0일 = 이번 달의 마지막 날
}
 
// dailyRecords: {date: {field: number, ...}} 형태(ds.dailyMap / ds.worktypeDailyMap 공통 형태).
// dayCap이 null이면 그 달 전체, 숫자면 1일~dayCap일까지만 합산합니다.
function sumFieldsForMonth(dailyRecords, ym, dayCap, fieldNames) {
  const out = {};
  fieldNames.forEach(f => { out[f] = 0; });
  Object.keys(dailyRecords).forEach(date => {
    if (!date.startsWith(ym)) return;
    const day = Number(date.slice(8, 10));
    if (dayCap != null && day > dayCap) return;
    const rec = dailyRecords[date];
    fieldNames.forEach(f => { out[f] += (rec[f] || 0); });
  });
  return out;
}
 
// (참고용으로 남겨둔 전체-월 합계 유틸 — computeMonthlySignals()는 월초 착시 방지를 위해
// 아래 함수 대신 sumFieldsForMonth()로 날짜를 잘라가며 직접 재집계합니다.)
function monthlyCategorySums(ds) {
  const sums = {};
  ds.DATA.daily.forEach(d => {
    const ym = monthKey(d.date);
    if (!sums[ym]) sums[ym] = { total: 0 };
    MAIN_CATS.forEach(c => { sums[ym][c] = (sums[ym][c] || 0) + (d[c] || 0); });
    sums[ym].total += d.total;
  });
  const months = Object.keys(sums).sort();
  return { months, sums };
}
 
function monthlyWorktypeSums(ds) {
  const sums = {};
  Object.keys(ds.worktypeDailyMap).forEach(date => {
    const ym = monthKey(date);
    if (!sums[ym]) sums[ym] = {};
    const rec = ds.worktypeDailyMap[date];
    TREND_WORKTYPES.forEach(t => { sums[ym][t] = (sums[ym][t] || 0) + (rec[t] || 0); });
  });
  const months = Object.keys(sums).sort();
  return { months, sums };
}
 
function computeMonthlySignals(ds) {
  const { COMPANY_NAMES, dailyMap, worktypeDailyMap, DATA } = ds;
  const allDates = Object.keys(dailyMap).sort();
  const monthList = [...new Set(allDates.map(monthKey))].sort();
 
  if (monthList.length < 2) {
    return { hasEnoughData: false, compositionHighlights: [], rawdataHighlights: [] };
  }
 
  const latestYm = monthList[monthList.length - 1];
  const prevYm = monthList[monthList.length - 2];
 
  // 이번 달이 아직 그 달의 마지막 날짜까지 데이터가 없으면(=진행 중) 전월도 같은 날짜까지만 자릅니다.
  const latestDay = Number(DATA.date_max.slice(8, 10));
  const latestMonthComplete = latestDay >= daysInMonth(latestYm);
  const prevDayCap = latestMonthComplete ? null : Math.min(latestDay, daysInMonth(prevYm));
  const periodLabel = latestMonthComplete ? '전월' : `전월 동기간(1~${prevDayCap}일)`;
  const comparisonNote = latestMonthComplete
    ? null
    : `이번 달(${latestYm})은 ${latestDay}일까지만 집계된 상태라, 공정한 비교를 위해 전월(${prevYm})도 1~${prevDayCap}일 데이터만 사용해 비교했습니다. 이번 달이 아직 끝나지 않았다는 점을 감안해 해석해주세요.`;
 
  const CAT_FIELDS = MAIN_CATS.concat('total');
  const latestCat = sumFieldsForMonth(dailyMap, latestYm, null, CAT_FIELDS);
  const prevCat = sumFieldsForMonth(dailyMap, prevYm, prevDayCap, CAT_FIELDS);
 
  const compositionHighlights = [];
  const rawdataHighlights = [];
 
  // 1) 월간 총량 변화 — 원자료 표 탭(월별 현황표) 관점
  if (prevCat.total >= MONTHLY_MIN_BASE) {
    const pct = (latestCat.total - prevCat.total) / prevCat.total * 100;
    if (Math.abs(pct) >= MONTHLY_THRESH_PCT) {
      rawdataHighlights.push({
        text: `전체 공고 건수가 ${periodLabel}(${prevYm}) ${prevCat.total}건 → 이번 달(${latestYm}) ${latestCat.total}건으로 ${pct > 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(0)}% ${pct > 0 ? '증가' : '감소'}했습니다.`,
        score: Math.abs(pct), type: 'monthly_total', direction: pct > 0 ? 'up' : 'down', subject: null, pct,
      });
    }
  }
 
  // 2) 대분류(POUR/다특허/DO/CNC/일반/타사) 구성비 변화 — 구성 · 순위 탭 관점
  MAIN_CATS.forEach(cat => {
    const r = latestCat[cat] || 0, p = prevCat[cat] || 0;
    if (p < MONTHLY_MIN_BASE) return;
    const pct = (r - p) / p * 100;
    if (Math.abs(pct) >= MONTHLY_THRESH_PCT) {
      compositionHighlights.push({
        text: `${cat} 구분 공고가 ${periodLabel} ${p}건 → 이번 달 ${r}건으로 ${pct > 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(0)}% ${pct > 0 ? '증가' : '감소'}했습니다.`,
        score: Math.abs(pct), type: 'category', subject: cat, direction: pct > 0 ? 'up' : 'down', pct,
      });
    }
  });
 
  // 3) POUR 비중(전체 대비) 월간 변화
  const pourShareLatest = latestCat.total ? (latestCat['POUR'] || 0) / latestCat.total * 100 : 0;
  const pourSharePrevM = prevCat.total ? (prevCat['POUR'] || 0) / prevCat.total * 100 : 0;
  const shareDiffM = pourShareLatest - pourSharePrevM;
  if (prevCat.total >= MONTHLY_MIN_BASE && Math.abs(shareDiffM) >= 3) {
    compositionHighlights.push({
      text: `전체 공고 중 POUR 비중이 ${periodLabel} ${pourSharePrevM.toFixed(1)}% → 이번 달 ${pourShareLatest.toFixed(1)}%로 ${shareDiffM > 0 ? '▲' : '▼'}${Math.abs(shareDiffM).toFixed(1)}%p ${shareDiffM > 0 ? '상승' : '하락'}했습니다.`,
      score: Math.abs(shareDiffM) * 8, type: 'pour_share_m', direction: shareDiffM > 0 ? 'up' : 'down', subject: null, magnitude: shareDiffM,
    });
  }
 
  // 4) 공종(옥상방수/재도장/주차장/도로/기타/미분류) 월간 변화 — 구성 · 순위 탭 관점
  const latestWt = sumFieldsForMonth(worktypeDailyMap, latestYm, null, TREND_WORKTYPES);
  const prevWt = sumFieldsForMonth(worktypeDailyMap, prevYm, prevDayCap, TREND_WORKTYPES);
  TREND_WORKTYPES.forEach(type => {
    const r = latestWt[type] || 0, p = prevWt[type] || 0;
    if (p === 0) {
      if (r >= MONTHLY_MIN_BASE) compositionHighlights.push({ text: `${type} 공종이 이번 달 새로 ${r}건 발생했습니다 (${periodLabel} 0건).`, score: 55, type: 'worktype_m', subject: type, direction: 'new' });
      return;
    }
    if (p < MONTHLY_MIN_BASE) return;
    const pct = (r - p) / p * 100;
    if (Math.abs(pct) >= MONTHLY_THRESH_PCT) compositionHighlights.push({ text: `${type} 공종이 ${periodLabel} ${p}건 → 이번 달 ${r}건으로 ${pct > 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(0)}% ${pct > 0 ? '증가' : '감소'}했습니다.`, score: Math.abs(pct), type: 'worktype_m', subject: type, direction: pct > 0 ? 'up' : 'down', pct });
  });
 
  // 5) 업체별 월간 변화 + 1위 업체 변동 — 구성 · 순위 탭(업체별 순위) + 원자료 표 탭 공통 소재
  //    (업체별 건수는 buildDatasets에서 이미 dailyMap 각 날짜 레코드에 병합돼 있어, 위와 동일한
  //     방식으로 day-capped 재집계가 가능합니다.)
  const latestCo = sumFieldsForMonth(dailyMap, latestYm, null, COMPANY_NAMES);
  const prevCo = sumFieldsForMonth(dailyMap, prevYm, prevDayCap, COMPANY_NAMES);
  let topLatest = null, topPrev = null;
  COMPANY_NAMES.forEach(name => {
    if (name.startsWith('기타')) return;
    const r = latestCo[name] || 0, p = prevCo[name] || 0;
    if (!topLatest || r > topLatest.v) topLatest = { name, v: r };
    if (!topPrev || p > topPrev.v) topPrev = { name, v: p };
    if (p === 0) {
      if (r >= MONTHLY_MIN_BASE) compositionHighlights.push({ text: `${name}${josa(name, '이가')} 이번 달 새로 ${r}건 등장했습니다 (${periodLabel} 0건).`, score: 60, type: 'company_m', subject: name, direction: 'new' });
      return;
    }
    if (p < MONTHLY_MIN_BASE) return;
    const pct = (r - p) / p * 100;
    if (Math.abs(pct) >= MONTHLY_THRESH_PCT) compositionHighlights.push({ text: `${name}${josa(name, '이가')} ${periodLabel} ${p}건 → 이번 달 ${r}건으로 ${pct > 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(0)}% ${pct > 0 ? '증가' : '감소'}했습니다.`, score: Math.abs(pct), type: 'company_m', subject: name, direction: pct > 0 ? 'up' : 'down', pct });
  });
  if (topLatest && topPrev && topLatest.name !== topPrev.name && topLatest.v >= MONTHLY_MIN_BASE) {
    rawdataHighlights.push({ text: `이번 달 공고 1위 업체가 ${topPrev.name}(${periodLabel})에서 ${topLatest.name}(이번 달, ${topLatest.v}건)로 바뀌었습니다.`, score: 90, type: 'top_competitor', subject: topLatest.name, direction: 'changed' });
  }
 
  compositionHighlights.sort((a, b) => b.score - a.score);
  rawdataHighlights.sort((a, b) => b.score - a.score);
 
  return {
    hasEnoughData: true, latestYm, prevYm,
    latestTotal: latestCat.total, prevTotal: prevCat.total,
    pourShareLatest, pourSharePrev: pourSharePrevM,
    latestMonthComplete, comparisonNote,
    compositionHighlights, rawdataHighlights,
  };
}
 
// ---------------------------------------------------------------------------
// 4. AI 제공사 호출 계층 — Claude(Anthropic) / Gemini(Google) 중 AI_PROVIDER로 선택.
//    두 함수 모두 "프롬프트 문자열만 받아 생성된 텍스트만 반환"하는 동일한 시그니처라,
//    아래 callClaude()/callClaudeForSignals()의 신호 계산·안전장치 로직은 제공사와
//    무관하게 그대로 유지됩니다 — 바뀌는 건 요청/응답을 주고받는 이 부분뿐입니다.
// ---------------------------------------------------------------------------
async function callAnthropicApi(prompt, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않습니다. (AI_PROVIDER=claude일 때 필요 — GitHub Repository Secret 확인)');
 
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Claude API 호출 실패: HTTP ${res.status} ${errText}`);
  }
  const json = await res.json();
  return (json.content || []).map(b => b.text || '').join('').trim() || '(응답이 비어 있습니다)';
}
 
async function callGeminiApi(prompt, maxTokens) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 환경변수가 설정되어 있지 않습니다. (AI_PROVIDER=gemini일 때 필요 — GitHub Repository Secret 확인)');
 
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API 호출 실패: HTTP ${res.status} ${errText}`);
  }
  const json = await res.json();
  const candidate = (json.candidates || [])[0];
  const parts = candidate && candidate.content && candidate.content.parts ? candidate.content.parts : [];
  const text = parts.map(p => p.text || '').join('').trim();
  return text || '(응답이 비어 있습니다)';
}
 
async function callAiProvider(prompt, maxTokens) {
  return AI_PROVIDER === 'claude' ? callAnthropicApi(prompt, maxTokens) : callGeminiApi(prompt, maxTokens);
}
 
// ---------------------------------------------------------------------------
// 4' [v6] 웹 검색이 켜진 버전 — 위 callAnthropicApi/callGeminiApi와 동일한 API를 쓰되,
//    Claude는 web_search 도구를, Gemini는 구글 검색 연동(google_search) 도구를 함께
//    요청합니다. 반환값은 { text, sources }로, sources는 실제로 참고된 웹 페이지
//    목록(중복 제거)입니다 — 화면에 "참고 출처"로 그대로 노출하기 위함입니다.
//    [v6.1] Gemini 웹 검색 호출은 GEMINI_MODEL이 아니라 GEMINI_SEARCH_MODEL을 씁니다
//    (결제 미등록 키에서도 무료로 지원되는 모델로 고정하기 위함 — 상단 설명 참고).
// ---------------------------------------------------------------------------
async function callAnthropicApiWithSearch(prompt, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않습니다.');
 
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Claude(웹검색) API 호출 실패: HTTP ${res.status} ${errText}`);
  }
  const json = await res.json();
  const blocks = json.content || [];
  const text = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
  const sources = [];
  const seenUrls = new Set();
  blocks.forEach(b => {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      b.content.forEach(r => {
        if (r.url && !seenUrls.has(r.url)) { seenUrls.add(r.url); sources.push({ title: r.title || r.url, url: r.url }); }
      });
    }
  });
  return { text: text || '(응답이 비어 있습니다)', sources };
}
 
async function callGeminiApiWithSearch(prompt, maxTokens) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 환경변수가 설정되어 있지 않습니다.');
 
  // [v6.1] 여기만 GEMINI_MODEL이 아니라 GEMINI_SEARCH_MODEL을 씁니다.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_SEARCH_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini(웹검색) API 호출 실패: HTTP ${res.status} ${errText}`);
  }
  const json = await res.json();
  const candidate = (json.candidates || [])[0];
  const parts = candidate && candidate.content && candidate.content.parts ? candidate.content.parts : [];
  const text = parts.map(p => p.text || '').join('').trim();
  const chunks = (candidate && candidate.groundingMetadata && candidate.groundingMetadata.groundingChunks) || [];
  const sources = [];
  const seenUrls = new Set();
  chunks.forEach(c => {
    const web = c.web || {};
    if (web.uri && !seenUrls.has(web.uri)) { seenUrls.add(web.uri); sources.push({ title: web.title || web.uri, url: web.uri }); }
  });
  return { text: text || '(응답이 비어 있습니다)', sources };
}
 
async function callAiProviderWithSearch(prompt, maxTokens) {
  return AI_PROVIDER === 'claude' ? callAnthropicApiWithSearch(prompt, maxTokens) : callGeminiApiWithSearch(prompt, maxTokens);
}
 
function extractJsonArray(text) {
  if (!text) return null;
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}
 
// ---------------------------------------------------------------------------
// 4c. [v6] 웹 검색 기반 "권장 조치" 보강 — 오늘의 브리핑 상위 신호(최대 WEB_ACTION_TOP_N건)에
//    대해, 규칙 기반 문구(ACTION_MAP)보다 구체적인 대응 방안을 웹 검색을 활용해 작성합니다.
//    비용/리스크 통제:
//      - 하루 1회, 신호 최대 3건을 묶어 API 호출 1회로 처리(신호 수만큼 반복 호출하지 않음).
//      - 신호가 하나도 없으면 호출 자체를 생략합니다.
//      - 응답이 JSON으로 파싱되지 않거나 API 호출이 실패하면 빈 배열을 반환 — 대시보드는
//        이 경우 기존 규칙 기반 권장 조치만 그대로 보여주므로 실패해도 안전합니다.
//      - "alert"(예: POUR 연속 무공고) 신호는 이미 문구 자체가 충분히 구체적이라 제외합니다.
// ---------------------------------------------------------------------------
const WEB_ACTION_TOP_N = 3;
 
async function generateWebInformedActions(highlights) {
  const top = highlights.filter(h => h.direction !== 'alert').slice(0, WEB_ACTION_TOP_N);
  if (top.length === 0) return [];
 
  const signalText = top.map((h, i) => `${i + 1}. [${h.type}/${h.direction}] ${h.text}${actionFor(h) ? ` (기존 규칙 기반 권장 조치: ${actionFor(h)})` : ''}`).join('\n');
 
  const prompt = `당신은 건설 특허공법(POUR) 시장의 공고문 데이터를 분석해 실무진에게 구체적인 대응 방안을 제안하는 애널리스트입니다.
아래 신호들은 이미 데이터로 확인된 사실입니다. 각 신호에 대해 웹 검색으로 관련 최신 정보(업계 동향, 관련 기업 뉴스, 정책·시장 변화 등)를
찾아본 뒤, "점검 필요"·"확인 필요" 같은 막연한 말이 아니라 실무진이 바로 참고할 수 있는 더 구체적인 대응 방안을 작성하세요.
 
[신호 목록]
${signalText}
 
지시사항:
- 신호 자체(사실관계)는 위 목록의 내용만 사용하고, 신호 자체를 추측하거나 새로 만들어내지 마세요.
- "대응 방안"에는 웹 검색으로 찾은 관련 최신 정보를 반영해 더 구체적으로 작성하되, 확실하지 않은 추측은 "추정"이라고 명시하세요.
- 검색으로 찾은 근거가 전혀 없다면 억지로 지어내지 말고, 기존 규칙 기반 권장 조치보다 조금 더 구체화한 수준으로만 작성하세요.
- 각 항목마다 실제로 참고한 출처가 있으면 note에 요약해 남기세요. 없으면 "검색 결과 없음"이라고 쓰세요.
- 존댓말을 사용하세요.
- 아래 JSON 배열 형식으로만 답하세요. 다른 설명 문장은 붙이지 마세요.
[
  { "index": 1, "action": "구체적인 대응 방안 (한국어, 존댓말, 1~2문장)", "note": "웹 검색 근거 요약 또는 '검색 결과 없음'" }
]`;
 
  let result;
  try {
    result = await callAiProviderWithSearch(prompt, 1536);
  } catch (e) {
    console.warn(`  - ⚠ 웹 검색 기반 권장 조치 생성 실패(건너뜀): ${e.message}`);
    return [];
  }
 
  const parsed = extractJsonArray(result.text);
  if (!Array.isArray(parsed)) {
    console.warn('  - ⚠ 웹 검색 기반 권장 조치 응답 파싱 실패(건너뜀)');
    return [];
  }
 
  return parsed.map(item => {
    const idx = Number(item.index) - 1;
    const h = top[idx];
    if (!h || !item.action) return null;
    return {
      text: h.text,
      type: h.type,
      direction: h.direction,
      subject: h.subject || null,
      rule_action: actionFor(h),
      ai_action: String(item.action).trim(),
      note: item.note ? String(item.note).trim() : null,
      sources: result.sources || [],
    };
  }).filter(Boolean);
}
 
// ---------------------------------------------------------------------------
// 4a. 오늘의 브리핑용 코멘트 — 이미 계산된 신호만 근거로 생성 (추측/창작 금지 명시)
// ---------------------------------------------------------------------------
async function callClaude(ctx) {
  const { highlights, recent7, prev7, pourShareRecent, pourSharePrev, pourDrySpell } = ctx;
  const top = highlights.slice(0, 10);
 
  if (top.length === 0) {
    return {
      commentary: '최근 7일간 직전 7일 대비 뚜렷한 변동 신호가 감지되지 않았습니다. 특이사항 없이 안정적인 흐름입니다.',
      model: null, // 규칙만으로 판단, API 호출 생략(비용 절감)
    };
  }
 
  const signalText = top.map((h, i) => `${i + 1}. ${h.text}${actionFor(h) ? ` (규칙상 권장 조치: ${actionFor(h)})` : ''}`).join('\n');
 
  const prompt = `당신은 건설 특허공법(POUR) 시장의 공고문 데이터를 분석해 실무진에게 보고하는 애널리스트입니다.
아래는 "최근 7일(${recent7[0]}~${recent7[6]})"을 "직전 7일(${prev7[0]}~${prev7[6]})"과 비교해 이미 규칙 기반으로 계산된 변동 신호 목록입니다.
POUR 점유율: 직전 7일 ${pourSharePrev.toFixed(1)}% → 최근 7일 ${pourShareRecent.toFixed(1)}%
POUR 연속 무공고 일수: ${pourDrySpell}일
 
[감지된 신호 목록]
${signalText}
 
지시사항:
- 위 신호 목록에 있는 내용만 근거로 사용하세요. 목록에 없는 원인이나 배경을 추측해서 만들어내지 마세요.
- 여러 신호 사이에 연관성이 보이면 짚어주되, 확실하지 않으면 "확실하지 않음" 또는 "추가 확인 필요"라고 명시하세요.
- 과장하지 말고 사실 위주로, 실무진이 바로 읽을 수 있도록 개조식(글머리 기호 없이 문장 단위로 끊어) 한국어로 3~5문장 이내로 작성하세요.
- 존댓말을 사용하세요.`;
 
  const commentary = await callAiProvider(prompt, 1024);
  return { commentary, model: MODEL };
}
 
// ---------------------------------------------------------------------------
// 4b. 월간 신호 전용 코멘트 — "구성 · 순위" / "원자료 표" 탭 종합 세션에 쓰입니다.
//     callClaude()와 동일한 안전장치(신호만 근거로 사용, 신호 0건이면 API 호출 생략)를
//     그대로 따르되, 프롬프트 관점(역할 설명)만 다릅니다.
// ---------------------------------------------------------------------------
async function callClaudeForSignals(highlights, opts) {
  const top = highlights.slice(0, 8);
  if (top.length === 0) {
    return { commentary: opts.noSignalText, model: null }; // 신호 없음 → API 호출 생략(비용 절감)
  }
 
  const signalText = top.map((h, i) => `${i + 1}. ${h.text}${actionFor(h) ? ` (규칙상 권장 조치: ${actionFor(h)})` : ''}`).join('\n');
 
  // periodOverride가 있으면(예: 주간 비교) 해당 문구를 그대로 쓰고, 없으면 기존 "이번 달 vs 전월" 문구를 씁니다.
  const periodPhrase = opts.periodOverride || `"이번 달(${opts.latestYm})"을 "전월(${opts.prevYm})"과`;
 
  const prompt = `${opts.roleDesc}
아래는 ${periodPhrase} 비교해 이미 규칙 기반으로 계산된 변동 신호 목록입니다.
${opts.extraContext ? `\n${opts.extraContext}\n` : ''}
[감지된 신호 목록]
${signalText}
 
지시사항:
- 위 신호 목록에 있는 내용만 근거로 사용하세요. 목록에 없는 원인이나 배경을 추측해서 만들어내지 마세요.
- 여러 신호 사이에 연관성이 보이면 짚어주되, 확실하지 않으면 "확실하지 않음" 또는 "추가 확인 필요"라고 명시하세요.
- 위에 "비교 기준" 안내가 있다면(현재 기간이 아직 진행 중이거나 일부만 집계된 경우), 감소/증가 폭을 단정적으로 "문제"라고 말하지 말고 이 점을 함께 언급하세요.
- 과장하지 말고 사실 위주로, 실무진이 바로 읽을 수 있도록 문장 단위로 끊어 한국어로 2~4문장 이내로 작성하세요.
- 존댓말을 사용하세요.`;
 
  const commentary = await callAiProvider(prompt, 512);
  return { commentary, model: MODEL };
}
 
// ---------------------------------------------------------------------------
// 5. 메인 실행
// ---------------------------------------------------------------------------
async function main() {
  console.log('[1/9] 구글 스프레드시트에서 데이터 가져오는 중...');
  const [patentCsv, mainCsv] = await Promise.all([fetchCsv(PATENT_GID), fetchCsv(DATA_GID)]);
  const patentRows = parseCsv(patentCsv);
  const mainRows = parseCsv(mainCsv);
  console.log(`  - 특허매핑 ${patentRows.length - 1}행, 원본데이터 ${mainRows.length - 1}행`);
 
  console.log('[2/9] 대시보드와 동일한 규칙으로 집계 중...');
  const ds = buildDatasets(patentRows, mainRows);
 
  console.log('[3/9] 변동 신호(하이라이트) 계산 중...');
  const ctx = computeHighlights(ds);
  console.log(`  - 감지된 신호 ${ctx.highlights.length}건 (기준일 ${ctx.latestDate})`);
 
  console.log('[4/9] Claude API로 오늘의 브리핑 코멘트 생성 중...');
  const result = await callClaude(ctx);
 
  console.log('[5/9] 웹 검색 기반 권장 조치 보강 생성 중 (오늘의 브리핑 상위 신호)...');
  const webActions = await generateWebInformedActions(ctx.highlights);
  console.log(webActions.length ? `  - ${webActions.length}건 생성됨` : '  - 생성 안 됨(신호 없음 또는 실패 — 규칙 기반 권장 조치만 표시됨)');
 
  console.log('[6/9] 월간(전월 대비) 변동 신호 계산 중 — 구성 · 순위 / 원자료 표 탭...');
  const mctx = computeMonthlySignals(ds);
 
  let compositionResult = { commentary: null, model: null };
  let rawdataResult = { commentary: null, model: null };
  if (mctx.hasEnoughData) {
    console.log(`  - 이번 달 ${mctx.latestYm} vs 전월 ${mctx.prevYm} / 구성 신호 ${mctx.compositionHighlights.length}건, 원자료 신호 ${mctx.rawdataHighlights.length}건`);
    console.log('[7/9] Claude API로 탭별 종합(구성 · 순위 / 원자료 표) 코멘트 생성 중...');
    if (mctx.comparisonNote) console.log(`  - ⚠ ${mctx.comparisonNote}`);
    compositionResult = await callClaudeForSignals(mctx.compositionHighlights, {
      latestYm: mctx.latestYm,
      prevYm: mctx.prevYm,
      roleDesc: '당신은 건설 특허공법(POUR) 시장의 공고문 데이터를 분석해, "공종 구성 및 업체별 순위" 관점에서 실무진에게 보고하는 애널리스트입니다.',
      noSignalText: '전월 대비 구성비·공종·업체 순위에 뚜렷한 변동 신호가 감지되지 않았습니다. 특이사항 없이 안정적인 흐름입니다.',
      extraContext: mctx.comparisonNote ? `※ 비교 기준: ${mctx.comparisonNote}` : null,
    });
    rawdataResult = await callClaudeForSignals(mctx.rawdataHighlights, {
      latestYm: mctx.latestYm,
      prevYm: mctx.prevYm,
      roleDesc: '당신은 건설 특허공법(POUR) 시장의 공고문 데이터를 분석해, "월별 전체 물량 및 1위 업체 변동" 관점에서 실무진에게 보고하는 애널리스트입니다.',
      noSignalText: '전월 대비 전체 물량·1위 업체 순위에 뚜렷한 변동 신호가 감지되지 않았습니다. 특이사항 없이 안정적인 흐름입니다.',
      extraContext: mctx.comparisonNote ? `※ 비교 기준: ${mctx.comparisonNote}` : null,
    });
  } else {
    console.log('  - 월 데이터가 2개월 미만이라 월간 비교를 건너뜁니다.');
  }
 
  console.log('[8/9] 주간(최근 N주 대비) 변동 신호 계산 중 — 추세 분석 탭 (주요 대분류 · 주차별)...');
  const tctx = computeTrendWeeklySignals(ds);
 
  let trendResult = { commentary: null, model: null };
  if (tctx.hasEnoughData) {
    console.log(`  - 최근 ${tctx.span}주 vs 직전 ${tctx.span}주 / 추세 신호 ${tctx.highlights.length}건`);
    console.log('[9/9] Claude API로 추세 분석 탭 종합 코멘트 생성 중...');
    if (tctx.comparisonNote) console.log(`  - ⚠ ${tctx.comparisonNote}`);
    trendResult = await callClaudeForSignals(tctx.highlights, {
      latestYm: null,
      prevYm: null,
      roleDesc: `당신은 건설 특허공법(POUR) 시장의 공고문 데이터를 분석해, "최근 몇 주간 대분류(POUR/다특허/DO/CNC/일반/타사)별 물량 흐름" 관점에서 실무진에게 보고하는 애널리스트입니다.`,
      noSignalText: '최근 몇 주간 대분류별 물량에 뚜렷한 변동 신호가 감지되지 않았습니다. 특이사항 없이 안정적인 흐름입니다.',
      extraContext: tctx.comparisonNote ? `※ 비교 기준: ${tctx.comparisonNote}` : null,
      periodOverride: tctx.hasEnoughData ? `"최근 ${tctx.span}주(${tctx.recentWeeks[0]}~)"를 "직전 ${tctx.span}주(${tctx.prevWeeks[0]}~)"와` : null,
    });
  } else {
    console.log('  - 주 데이터가 2주 미만이라 주간 비교를 건너뜁니다.');
  }
 
  const output = {
    generated_at: new Date().toISOString(),
    model: result.model,
    latest_date: ctx.latestDate,
    period: { recent7: [ctx.recent7[0], ctx.recent7[6]], prev7: [ctx.prev7[0], ctx.prev7[6]] },
    pour_share: { recent: Number(ctx.pourShareRecent.toFixed(1)), prev: Number(ctx.pourSharePrev.toFixed(1)) },
    pour_dry_spell_days: ctx.pourDrySpell,
    highlights: ctx.highlights.slice(0, 10).map(h => ({
      text: h.text, type: h.type, direction: h.direction, subject: h.subject || null,
      action: actionFor(h),
    })),
    commentary: result.commentary,
 
    // --- [v6] 오늘의 브리핑 상위 신호에 대한 웹 검색 기반 "권장 조치" 보강 (실패/신호없음 시 빈 배열) ---
    highlight_actions_ai: webActions,
    web_action_model: webActions.length ? SEARCH_MODEL : null,
 
    // --- 구성 · 순위 / 원자료 표 탭의 "종합" 세션용 월간(전월 대비) AI 코멘트 ---
    monthly_period: mctx.hasEnoughData ? {
      latest: mctx.latestYm, prev: mctx.prevYm,
      latest_month_complete: mctx.latestMonthComplete,
      comparison_note: mctx.comparisonNote,
    } : null,
    composition_model: compositionResult.model,
    composition_highlights: mctx.hasEnoughData ? mctx.compositionHighlights.slice(0, 8).map(h => ({
      text: h.text, type: h.type, direction: h.direction, subject: h.subject || null,
      action: actionFor(h),
    })) : [],
    composition_commentary: compositionResult.commentary,
    rawdata_model: rawdataResult.model,
    rawdata_highlights: mctx.hasEnoughData ? mctx.rawdataHighlights.slice(0, 8).map(h => ({
      text: h.text, type: h.type, direction: h.direction, subject: h.subject || null,
      action: actionFor(h),
    })) : [],
    rawdata_commentary: rawdataResult.commentary,
 
    // --- "추세 분석" 탭의 "종합" 세션용 주간(주요 대분류 · 최근 N주 vs 직전 N주) AI 코멘트 ---
    trend_period: tctx.hasEnoughData ? {
      span_weeks: tctx.span,
      recent_weeks: [tctx.recentWeeks[0], tctx.recentWeeks[tctx.recentWeeks.length - 1]],
      prev_weeks: [tctx.prevWeeks[0], tctx.prevWeeks[tctx.prevWeeks.length - 1]],
      comparison_note: tctx.comparisonNote,
    } : null,
    trend_model: trendResult.model,
    trend_highlights: tctx.hasEnoughData ? tctx.highlights.slice(0, 8).map(h => ({
      text: h.text, type: h.type, direction: h.direction, subject: h.subject || null,
      action: actionFor(h),
    })) : [],
    trend_commentary: trendResult.commentary,
  };
 
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`완료: ${OUTPUT_PATH} 저장됨`);
}
 
// require()로 다른 스크립트(테스트 등)에서 함수만 가져다 쓸 때는 자동 실행되지 않도록,
// 이 파일이 직접 실행된 경우에만 main()을 호출합니다.
if (require.main === module) {
  main().catch(err => {
    console.error('오류:', err.message);
    process.exit(1);
  });
}
 
module.exports = {
  parseCsv, normalizeCompanyName, buildDatasets, computeHighlights, ACTION_MAP, actionFor,
  josa, computeMonthlySignals, monthlyCategorySums, monthlyWorktypeSums,
  computeTrendWeeklySignals, weekMondayStr,
  extractJsonArray, generateWebInformedActions,
};
