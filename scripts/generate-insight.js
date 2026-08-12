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
 * 오늘의 브리핑 상위 신호(최대 3건, 비용 통제용)에 대해서만 웹 검색을 반영한 AI 호출을
 * 추가로 1회 실행해 더 구체적인 "웹 검색 기반 대응 방안"을 만들고, highlight_actions_ai로
 * 저장합니다. 신호 자체(사실관계)는 여전히 위에서 이미 계산된 것만 사용하며, "대응 방안"에
 * 한해서만 웹 검색 결과 반영을 허용합니다 — 반드시 참고 출처와 함께. 웹 검색 호출이 실패하거나
 * 응답 파싱이 안 되면 이 보강 없이 조용히 건너뛰며(빈 배열), 기존 규칙 기반 권장 조치·오늘의
 * 브리핑 코멘트에는 전혀 영향이 없습니다.
 *
 * [v7 교체 — 2026-08-11] v6은 Gemini/Claude에 내장된 "웹 검색(Grounding)" 기능을 그대로
 * 썼는데, 두 회사 모두 결제 미등록(무료) API 키에서는 이 기능을 거의 지원하지 않고
 * (지원하던 구형 모델들도 이후 서비스 종료됨), 결제 등록이 필수가 되어버렸습니다. 결제
 * 등록 없이 계속 무료로 쓸 수 있도록, 웹 검색 자체는 별도의 검색 전용 API인 Tavily
 * (tavily.com — 카드 등록 없이 월 1,000건 무료)로 하고, 그 검색 결과(제목·URL·요약)만
 * 기존 AI 호출(callAiProvider — 그라운딩 도구 없는 일반 텍스트 생성 호출)에 참고자료로
 * 넘겨서 "대응 방안" 문장을 작성하게 하는 방식으로 바꿨습니다. 즉 "검색"과 "글쓰기"를
 * 분리한 것입니다. 안전장치는 v6과 동일합니다 — 신호(사실관계)는 이미 계산된 것만 사용,
 * 검색 결과가 없으면 억지로 지어내지 않음, 실패 시 빈 배열로 조용히 건너뜀.
 *
 * [v8 추가 — 2026-08-11] Joe 요청: "4A시스템·금영ENC·피엠씨·미래피앤씨·수퍼크랙실" 5개 주요
 * 경쟁사에 대해서는, 그날의 하이라이트 상위 3건에 뽑혔는지와 무관하게 매일 최신 동향을 검색해
 * 알려주는 기능을 추가했습니다. v7과 동일한 절차(회사명별 Tavily 검색 → 검색 결과를 일반 AI
 * 호출에 참고자료로 전달해 요약 문장 작성)를 쓰되, "오늘의 브리핑 상위 3건" 필터링 없이 5개사
 * 전원을 매일 고정으로 처리합니다. 결과는 competitor_watch_trends로 저장됩니다. 안전장치는
 * v7과 동일 — 검색 결과가 없으면 지어내지 않고 "최근 특이 동향 확인 안 됨"으로 처리, 검색/AI
 * 호출 실패 시 해당 항목(또는 전체)을 조용히 건너뜁니다.
 * (같은 날 추가) Joe 요청("구체적인 솔루션 제공은 어렵나요")에 따라, 각 업체 동향 요약(summary)
 * 뿐 아니라 그 동향에 대한 구체적인 대응 방안(action)도 함께 생성하도록 확장했습니다.
 *
 * [v9 정리 — 2026-08-11] Joe 요청("웹기반 대응 방안보다는 경쟁사 동향으로 수정해주시고 최신
 * 동향 정보 알 수 있게 해주세요")에 따라 v7의 "웹 검색 기반 대응 방안"(highlight_actions_ai,
 * 그날그날 바뀌는 하이라이트 상위 3건 기준)을 폐지하고, v8의 "경쟁사 동향"(competitor_watch_
 * trends, 5개사 고정)으로 일원화했습니다. 또한 "최신" 정보를 더 잘 반영하도록 Tavily 검색을
 * topic=news + 최근 1개월(time_range=month) 기준으로 우선 검색하고(결과 없으면 일반 검색으로
 * 대체) 결과 수도 3→5건으로 늘렸습니다.
 *
 * [v10 수정 — 2026-08-11] Joe 피드백("검색 출처가 좀 이상한데요") — 회사명만으로 검색하면
 * 인스타그램·나무위키 등 업체와 무관한 결과가 자주 섞였습니다. (1) 신뢰도 낮은/무관한
 * 도메인(인스타그램·나무위키·유튜브·SNS 등)을 검색 단계에서 기본 제외하고, (2) AI에게
 * "검색 결과 각각이 실제로 이 업체에 대한 내용이 맞는지" 먼저 판단하게 한 뒤, 실제로
 * 참고한 결과의 번호(used_indices)만 요청 — 원본 검색 결과 전체가 아니라 AI가 관련 있다고
 * 판단해 실제로 인용한 것만 화면의 "출처"에 표시되도록 바꿨습니다.
 *
 * [v11 추가 — 2026-08-11] Joe 요청("고객여정 데이터 대시보드에 연동해서 유의미한 의미를
 * 볼 수 있나") — B2B사업운영팀이 관리하는 별도 스프레드시트("POUR 컨설팅 내역서 발행
 * List")의 "여정_최종" 시트를 매일 함께 읽어와, 문의(L2)→컨설팅(L3)→공고(L4)→낙찰(L5)
 * 퍼널을 현장+공종 단위 케이스 기준 6개 유형(문의만/컨설팅후미상/공고진행중/유찰공고취소/
 * 타사낙찰/POUR낙찰성공)으로 규칙 기반 집계해 customer_journey_funnel로 저장합니다. AI
 * 호출이 전혀 없는 순수 집계 기능이며(숫자를 창작하지 않음), 이 시트는 위 POUR 공고문
 * 시트(SHEET_ID)와는 별개의 시트(JOURNEY_SHEET_ID)입니다. 확인된 한계: "타공법낙찰"
 * 행의 업체명은 실제 낙찰 경쟁사가 아니라 우리 협력사명이라, "어느 경쟁사가 이겼는지"까지는
 * 이 데이터만으로 알 수 없습니다(추후 필요 시 POUR 공고문 데이터와 별도 교차 매칭 필요).
 *
 * [v12 확장 — 2026-08-11] Joe 피드백("연결할 수 있는 결과 및 인사이트 도출이 안되는데
 * 어떻게 안될까요") — v11의 퍼널 총건수만으로는 실무진이 "어디부터 손봐야 하는지" 알기
 * 어렵다는 지적에 따라 두 가지를 추가했습니다. (1) 케이스별 주소·공종명에서 광역 지역(시/도)과
 * 대표 공종을 뽑아, 지역·공종 단위로 이탈률(문의/컨설팅에서 멈춘 비율)과 POUR 낙찰률을 다시
 * 집계(by_region/by_worktype, 표본 15건 미만은 제외)했습니다. (2) 그 수치만 근거로 "어디부터
 * 확인해볼 만한지" AI 코멘트(journey_funnel_commentary)를 생성했습니다 — 다른 코멘트 기능과
 * 동일하게 "왜" 이탈했는지는 이 데이터만으로 알 수 없다는 점을 프롬프트에 명시해 원인을
 * 지어내지 않도록 했습니다. (브랜드별 분류는 "여정_최종" 시트에 브랜드 컬럼이 없어 이번에는
 * 제외했습니다 — 필요하시면 "기술자문문의" 시트와 별도 매칭이 필요합니다.)
 *
 * [v13 추가 — 2026-08-12] Joe 요청("전년도와 비교할 수 있는 것도 필요해") — 라이브 공고문
 * 시트(SHEET_ID)는 2025-12-19부터 시작해 그 자체로는 전년 비교가 불가능함을 확인하고
 * Joe에게 알렸더니, "25년 전체 및 POUR 공법 공고문 현황.xlsx"를 업로드해주셨습니다. 그
 * 파일을 라이브 데이터와 동일한 규칙으로 일자별 집계해 data/reference-2025-daily.json에
 * 정적으로 저장하고(2025-01~12월 커버, 6,272행), "이번 달 vs 작년 같은 달"을 기존
 * "이번달 vs 전월" 로직과 동일한 유틸(day-cap 등)로 비교해 yoy_highlights/yoy_commentary로
 * 저장합니다. 참고 데이터는 GitHub Actions가 매일 다시 만드는 게 아니라 한 번 고정된
 * 값입니다 — 나중에 2026년이 지나 더 최근 "작년" 데이터가 필요해지면 이 파일을 교체해야
 * 합니다. 업체별(경쟁사) 전년 비교는 참고 파일의 특허번호 컬럼 구조가 달라 이번에는
 * 포함하지 않았습니다(구분·공종 단위만 지원).
 *
 * 필요 환경변수: AI_PROVIDER=claude 인 경우 ANTHROPIC_API_KEY,
 *              AI_PROVIDER=gemini 인 경우 GEMINI_API_KEY (둘 다 GitHub Repository Secret으로 등록)
 *              TAVILY_API_KEY — "웹 검색 기반 대응 방안"(v7) 기능에 필요. tavily.com에서
 *                무료 가입(카드 등록 불필요) 후 발급받은 키를 GitHub Repository Secret으로
 *                등록하세요. 이 키가 없거나 호출이 실패해도 나머지 기능에는 영향이 없습니다
 *                (이 기능만 조용히 건너뜁니다).
 * 선택 환경변수: AI_PROVIDER (기본값 gemini — 'claude' 또는 'gemini')
 *              CLAUDE_MODEL (AI_PROVIDER=claude일 때, 기본값 claude-haiku-4-5)
 *              GEMINI_MODEL (AI_PROVIDER=gemini일 때, 기본값 gemini-3.5-flash-lite — 가장 저렴한 모델)
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

// [v11 추가] "고객여정 퍼널" 기능용 — B2B사업운영팀이 관리하는 별도의 구글 스프레드시트
// ("POUR 컨설팅 내역서 발행 List") 중 "여정_최종" 탭. 위 SHEET_ID(공고문 데이터)와는
// 완전히 다른 시트이므로 SHEET_ID를 따로 둡니다. gviz CSV export가 익명으로 동작하려면
// 이 시트가 "링크가 있는 모든 사용자 - 뷰어"로 공유되어 있어야 합니다.
const JOURNEY_SHEET_ID = '1gRPRcxpWD-svZq7KfnS5FAugAtQNPq24J5Jml9SSE-s';
const JOURNEY_GID = '601103674'; // "여정_최종" 탭

const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'latest-insight.json');

// AI_PROVIDER: 'claude' 또는 'gemini' — 기본값은 gemini(현재 등록된 키 기준).
// 나중에 Anthropic 키를 등록하고 AI_PROVIDER=claude로만 바꾸면 코드 수정 없이 Claude로 전환됩니다.
const AI_PROVIDER = (process.env.AI_PROVIDER || 'gemini').trim().toLowerCase();
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const MODEL = AI_PROVIDER === 'claude' ? CLAUDE_MODEL : GEMINI_MODEL;

// ---------------------------------------------------------------------------
// 1. 시트 데이터 가져오기 (gviz CSV export) + CSV 파서
// ---------------------------------------------------------------------------
async function fetchCsv(gid, sheetId) {
  const id = sheetId || SHEET_ID;
  const url = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?gid=${gid}&tqx=out:csv`;
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
// 3b. [v13 추가] 전년동월 비교 — Joe 요청("전년도와 비교할 수 있는 것도 필요해").
//
//     라이브 시트(SHEET_ID)는 2025-12-19부터 시작해 2025년 데이터가 없어, 있는 데이터만으로는
//     전년 비교가 불가능합니다. Joe가 2026-08-12에 "25년 전체 및 POUR 공법 공고문 현황.xlsx"를
//     업로드해주셔서, 그 파일의 '25년 전체 공고문' 시트(6,277행, 2025-01-02~2025-12-31)를
//     라이브 데이터와 동일한 규칙(RAW_CATS/MAIN_CATS/METHOD_TYPE_COLS)으로 일자별 집계해
//     data/reference-2025-daily.json에 정적으로 저장해뒀습니다. 이 파일은 GitHub Actions가
//     매일 다시 만드는 게 아니라 한 번 고정된 참고 데이터입니다(2025년은 더 이상 바뀌지
//     않으므로) — 나중에 Joe가 더 오래된 데이터를 주시면 이 파일만 교체하면 됩니다.
//
//     비교 로직은 기존 "이번 달 vs 전월"(computeMonthlySignals)과 동일한 유틸
//     (sumFieldsForMonth, 월초 착시 방지용 day-cap)을 그대로 재사용해 "이번 달 vs 작년 같은
//     달"을 계산합니다. 업체별(경쟁사) 비교는 2025년 참고 파일의 특허번호 컬럼 구조가 달라
//     (특허번호2~15로 확장) 별도 매핑 작업이 필요해 이번에는 포함하지 않았습니다 — 구분(POUR/
//     다특허/DO/CNC/일반/타사)·공종(옥상방수·재도장·주차장·도로·기타·미분류) 단위만 지원합니다.
// ---------------------------------------------------------------------------
function loadReference2025() {
  try {
    const refPath = path.join(__dirname, '..', 'data', 'reference-2025-daily.json');
    const raw = fs.readFileSync(refPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const catDaily = {}, worktypeDaily = {};
    Object.entries(parsed.daily || {}).forEach(([date, rec]) => {
      catDaily[date] = {
        POUR: rec.POUR || 0, 다특허: rec.다특허 || 0, DO: rec.DO || 0,
        CNC: rec.CNC || 0, 일반: rec.일반 || 0, 타사: rec.타사 || 0, total: rec.total || 0,
      };
      worktypeDaily[date] = rec.worktypes || {};
    });
    return { catDaily, worktypeDaily, source: parsed.source || null };
  } catch (e) {
    console.warn(`  - ⚠ 2025년 참고 데이터(data/reference-2025-daily.json) 로드 실패(건너뜀): ${e.message}`);
    return null;
  }
}

function computeYoySignals(ds, ref) {
  if (!ref) return { hasEnoughData: false, highlights: [] };
  const { dailyMap, worktypeDailyMap, DATA } = ds;
  if (!DATA.date_max) return { hasEnoughData: false, highlights: [] };

  const latestYm = monthKey(DATA.date_max);
  const [y, m] = latestYm.split('-').map(Number);
  const yoyYm = `${y - 1}-${String(m).padStart(2, '0')}`;

  const hasYoyMonth = Object.keys(ref.catDaily).some(d => d.startsWith(yoyYm));
  if (!hasYoyMonth) {
    return { hasEnoughData: false, highlights: [], latestYm, yoyYm, noDataReason: `참고 데이터에 ${yoyYm} 데이터가 없습니다.` };
  }

  const latestDay = Number(DATA.date_max.slice(8, 10));
  const latestMonthComplete = latestDay >= daysInMonth(latestYm);
  const yoyDayCap = latestMonthComplete ? null : Math.min(latestDay, daysInMonth(yoyYm));
  const periodLabel = latestMonthComplete ? `작년 같은 달(${yoyYm})` : `작년 같은 기간(${yoyYm} 1~${yoyDayCap}일)`;
  const comparisonNote = latestMonthComplete
    ? null
    : `이번 달(${latestYm})은 ${latestDay}일까지만 집계된 상태라, 공정한 비교를 위해 작년 같은 달(${yoyYm})도 1~${yoyDayCap}일 데이터만 사용해 비교했습니다. 이번 달이 아직 끝나지 않았다는 점을 감안해 해석해주세요.`;

  const CAT_FIELDS = MAIN_CATS.concat('total');
  const latestCat = sumFieldsForMonth(dailyMap, latestYm, null, CAT_FIELDS);
  const yoyCat = sumFieldsForMonth(ref.catDaily, yoyYm, yoyDayCap, CAT_FIELDS);

  const highlights = [];

  if (yoyCat.total >= MONTHLY_MIN_BASE) {
    const pct = (latestCat.total - yoyCat.total) / yoyCat.total * 100;
    if (Math.abs(pct) >= MONTHLY_THRESH_PCT) {
      highlights.push({
        text: `전체 공고 건수가 ${periodLabel} ${yoyCat.total}건 → 이번 달(${latestYm}) ${latestCat.total}건으로 ${pct > 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(0)}% ${pct > 0 ? '증가' : '감소'}했습니다.`,
        score: Math.abs(pct), type: 'yoy_total', direction: pct > 0 ? 'up' : 'down', subject: null, pct,
      });
    }
  }

  MAIN_CATS.forEach(cat => {
    const r = latestCat[cat] || 0, p = yoyCat[cat] || 0;
    if (p < MONTHLY_MIN_BASE) return;
    const pct = (r - p) / p * 100;
    if (Math.abs(pct) >= MONTHLY_THRESH_PCT) {
      highlights.push({
        text: `${cat} 구분 공고가 ${periodLabel} ${p}건 → 이번 달 ${r}건으로 ${pct > 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(0)}% ${pct > 0 ? '증가' : '감소'}했습니다.`,
        score: Math.abs(pct), type: 'yoy_category', subject: cat, direction: pct > 0 ? 'up' : 'down', pct,
      });
    }
  });

  const pourShareLatest = latestCat.total ? (latestCat['POUR'] || 0) / latestCat.total * 100 : 0;
  const pourShareYoy = yoyCat.total ? (yoyCat['POUR'] || 0) / yoyCat.total * 100 : 0;
  const shareDiff = pourShareLatest - pourShareYoy;
  if (yoyCat.total >= MONTHLY_MIN_BASE && Math.abs(shareDiff) >= 3) {
    highlights.push({
      text: `전체 공고 중 POUR 비중이 ${periodLabel} ${pourShareYoy.toFixed(1)}% → 이번 달 ${pourShareLatest.toFixed(1)}%로 ${shareDiff > 0 ? '▲' : '▼'}${Math.abs(shareDiff).toFixed(1)}%p ${shareDiff > 0 ? '상승' : '하락'}했습니다.`,
      score: Math.abs(shareDiff) * 8, type: 'yoy_pour_share', direction: shareDiff > 0 ? 'up' : 'down', subject: null, magnitude: shareDiff,
    });
  }

  const latestWt = sumFieldsForMonth(worktypeDailyMap, latestYm, null, TREND_WORKTYPES);
  const yoyWt = sumFieldsForMonth(ref.worktypeDaily, yoyYm, yoyDayCap, TREND_WORKTYPES);
  TREND_WORKTYPES.forEach(type => {
    const r = latestWt[type] || 0, p = yoyWt[type] || 0;
    if (p < MONTHLY_MIN_BASE) return;
    const pct = (r - p) / p * 100;
    if (Math.abs(pct) >= MONTHLY_THRESH_PCT) {
      highlights.push({
        text: `${type} 공종이 ${periodLabel} ${p}건 → 이번 달 ${r}건으로 ${pct > 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(0)}% ${pct > 0 ? '증가' : '감소'}했습니다.`,
        score: Math.abs(pct), type: 'yoy_worktype', subject: type, direction: pct > 0 ? 'up' : 'down', pct,
      });
    }
  });

  highlights.sort((a, b) => b.score - a.score);

  return {
    hasEnoughData: true, latestYm, yoyYm, comparisonNote,
    latestTotal: latestCat.total, yoyTotal: yoyCat.total,
    highlights,
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
// 4' [v7] Tavily 검색 API 호출 — 카드 등록 없이 월 1,000건까지 무료(tavily.com)이며,
//    결과는 {title, url, content(요약)} 목록입니다. 이 결과 자체를 화면에 보여주는 게
//    아니라, AI 프롬프트에 "참고자료"로 넘겨 요약·대응 방안 문장을 쓰게 하는 재료로 씁니다.
//    [v9] opts.topic='news' + opts.timeRange를 지정하면 실제 뉴스성 최신 결과 위주로
//    필터링됩니다(경쟁사 동향처럼 "최신" 정보가 중요한 용도에 사용).
// ---------------------------------------------------------------------------
// [v10] 회사명만으로 검색하면 인스타그램·나무위키·유튜브 등 업체와 무관한 콘텐츠가 자주
// 섞여 들어옵니다(Joe 피드백: "검색 출처가 좀 이상한데요"). 기본적으로 제외할 도메인.
const DEFAULT_EXCLUDE_DOMAINS = ['instagram.com', 'namu.wiki', 'youtube.com', 'facebook.com', 'twitter.com', 'x.com', 'tiktok.com', 'pinterest.com'];

async function callTavilySearch(query, maxResults, opts) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('TAVILY_API_KEY 환경변수가 설정되어 있지 않습니다.');
  opts = opts || {};

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: maxResults || 3,
      topic: opts.topic || 'general',
      ...(opts.timeRange ? { time_range: opts.timeRange } : {}),
      // [v10] 회사명만으로는 검색이 인스타그램·나무위키·무관 뉴스 등으로 새기 쉬워, 신뢰도
      // 낮은/무관한 도메인을 기본적으로 제외합니다(호출부에서 opts.excludeDomains로 추가 가능).
      exclude_domains: (opts.excludeDomains || DEFAULT_EXCLUDE_DOMAINS),
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Tavily 검색 API 호출 실패: HTTP ${res.status} ${errText}`);
  }
  const json = await res.json();
  return (json.results || []).map(r => ({
    title: r.title || r.url,
    url: r.url,
    content: (r.content || '').slice(0, 400),
  }));
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

// [v7] 신호(하이라이트) 하나당 Tavily에 던질 검색어를 만듭니다. 신호 유형별로 검색 의도가
// 다르므로(공종 수요 동향 vs 특정 업체 뉴스) 유형에 따라 검색어를 다르게 구성합니다.
function buildSearchQueryFor(h) {
  if (!h.subject) return '건설 특허공법 POUR 시장 동향';
  if (h.type === 'worktype' || h.type === 'worktype_m' || h.type === 'trend_cat') {
    return `${h.subject} 공사 시장 동향 뉴스`;
  }
  return `${h.subject} 건설 특허공법 뉴스`;
}

// ---------------------------------------------------------------------------
// 4c. [v7] 웹 검색 기반 "권장 조치" 보강 — 오늘의 브리핑 상위 신호(최대 WEB_ACTION_TOP_N건)에
//    대해, 규칙 기반 문구(ACTION_MAP)보다 구체적인 대응 방안을 작성합니다.
//    절차: (1) 신호별로 Tavily 검색 → (2) 검색 결과를 신호와 함께 일반 AI 호출(그라운딩
//    도구 없음, callAiProvider)에 참고자료로 전달 → (3) AI가 대응 방안 문장을 작성.
//    비용/리스크 통제:
//      - 신호 최대 3건까지만 처리(Tavily 검색도 최대 3회, AI 호출은 여전히 1회로 묶음).
//      - 신호가 하나도 없으면 아무 호출도 하지 않습니다.
//      - Tavily 검색이 실패한 신호는 "검색 결과 없음"으로 처리하고 계속 진행합니다
//        (신호 전체를 중단시키지 않음).
//      - 최종 AI 호출이 실패하거나 응답이 JSON으로 파싱되지 않으면 빈 배열을 반환 —
//        대시보드는 이 경우 기존 규칙 기반 권장 조치만 그대로 보여주므로 실패해도 안전합니다.
//      - "alert"(예: POUR 연속 무공고) 신호는 이미 문구 자체가 충분히 구체적이라 제외합니다.
// ---------------------------------------------------------------------------
const WEB_ACTION_TOP_N = 3;

async function generateWebInformedActions(highlights) {
  const top = highlights.filter(h => h.direction !== 'alert').slice(0, WEB_ACTION_TOP_N);
  if (top.length === 0) return [];

  const searchPerSignal = [];
  for (const h of top) {
    const query = buildSearchQueryFor(h);
    try {
      const results = await callTavilySearch(query, 3);
      searchPerSignal.push({ highlight: h, results });
    } catch (e) {
      console.warn(`  - ⚠ Tavily 검색 실패(${h.subject || h.type}, 계속 진행): ${e.message}`);
      searchPerSignal.push({ highlight: h, results: [] });
    }
  }

  const signalText = searchPerSignal.map((item, i) => {
    const h = item.highlight;
    const searchBlock = item.results.length
      ? item.results.map((r, ri) => `   [검색결과${ri + 1}] ${r.title} (${r.url})\n   ${r.content}`).join('\n')
      : '   (검색 결과 없음)';
    return `${i + 1}. [${h.type}/${h.direction}] ${h.text}${actionFor(h) ? ` (기존 규칙 기반 권장 조치: ${actionFor(h)})` : ''}\n   관련 웹 검색 결과:\n${searchBlock}`;
  }).join('\n\n');

  const prompt = `당신은 건설 특허공법(POUR) 시장의 공고문 데이터를 분석해 실무진에게 구체적인 대응 방안을 제안하는 애널리스트입니다.
아래 신호들은 이미 데이터로 확인된 사실입니다. 각 신호 아래에는 관련 웹 검색 결과(제목·출처·요약)를 함께 제공했습니다.
이 검색 결과를 참고해 "점검 필요"·"확인 필요" 같은 막연한 말이 아니라 실무진이 바로 참고할 수 있는 더 구체적인 대응 방안을 작성하세요.

[신호 및 관련 검색 결과]
${signalText}

지시사항:
- 신호 자체(사실관계)는 위 목록의 내용만 사용하고, 신호 자체를 추측하거나 새로 만들어내지 마세요.
- "대응 방안"에는 위에 제공된 검색 결과만 근거로 사용하세요 — 검색 결과에 없는 내용을 지어내지 마세요.
- 해당 신호에 "(검색 결과 없음)"이라고 되어 있으면, 검색 결과를 지어내지 말고 기존 규칙 기반 권장 조치보다 조금 더 구체화한 수준으로만 작성하세요.
- 각 항목마다 실제로 참고한 검색 결과가 있으면 note에 요약해 남기세요(어느 검색결과 번호를 참고했는지 언급 가능). 없으면 "검색 결과 없음"이라고 쓰세요.
- 존댓말을 사용하세요.
- 아래 JSON 배열 형식으로만 답하세요. 다른 설명 문장은 붙이지 마세요.
[
  { "index": 1, "action": "구체적인 대응 방안 (한국어, 존댓말, 1~2문장)", "note": "참고한 검색 결과 요약 또는 '검색 결과 없음'" }
]`;

  let text;
  try {
    text = await callAiProvider(prompt, 1536);
  } catch (e) {
    console.warn(`  - ⚠ 웹 검색 기반 권장 조치 생성 실패(건너뜀): ${e.message}`);
    return [];
  }

  const parsed = extractJsonArray(text);
  if (!Array.isArray(parsed)) {
    console.warn('  - ⚠ 웹 검색 기반 권장 조치 응답 파싱 실패(건너뜀)');
    return [];
  }

  return parsed.map(item => {
    const idx = Number(item.index) - 1;
    const entry = searchPerSignal[idx];
    if (!entry || !item.action) return null;
    const h = entry.highlight;
    return {
      text: h.text,
      type: h.type,
      direction: h.direction,
      subject: h.subject || null,
      rule_action: actionFor(h),
      ai_action: String(item.action).trim(),
      note: item.note ? String(item.note).trim() : null,
      sources: entry.results.map(r => ({ title: r.title, url: r.url })),
    };
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// 4d. [v8] 주요 경쟁사 5개사 고정 동향 — Joe 요청. 그날의 하이라이트(변동 신호) 상위 3건에
//    뽑혔는지와 무관하게, 아래 5개 업체는 매일 고정으로 Tavily 검색 → 일반 AI 호출로 최신
//    동향을 요약합니다. 절차·안전장치는 generateWebInformedActions()(v7)와 동일합니다.
// ---------------------------------------------------------------------------
const COMPETITOR_WATCHLIST = ['4A시스템', '금영ENC', '피엠씨', '미래피앤씨', '수퍼크랙실'];

function buildCompetitorWatchQuery(name) {
  return `${name} 건설 특허공법 최신 소식`;
}

async function generateCompetitorWatchTrends(companyNames) {
  const list = companyNames && companyNames.length ? companyNames : COMPETITOR_WATCHLIST;
  if (list.length === 0) return [];

  const searchPerCompany = [];
  for (const name of list) {
    const query = buildCompetitorWatchQuery(name);
    try {
      // [v9] "최신 동향"이 핵심이므로 먼저 뉴스 카테고리 + 최근 1개월로 좁혀서 검색합니다.
      let results = await callTavilySearch(query, 5, { topic: 'news', timeRange: 'month' });
      // 5개사 모두가 매일 새 "뉴스"에 나오는 대기업은 아니라, 뉴스 검색이 비어 있으면
      // 일반 웹 검색으로 한 번 더 시도합니다(결과 없음으로 카드가 비는 것을 줄이기 위함).
      if (results.length === 0) {
        results = await callTavilySearch(query, 5, { topic: 'general' });
      }
      searchPerCompany.push({ name, results });
    } catch (e) {
      console.warn(`  - ⚠ Tavily 검색 실패(${name}, 계속 진행): ${e.message}`);
      searchPerCompany.push({ name, results: [] });
    }
  }

  const companyText = searchPerCompany.map((item, i) => {
    const searchBlock = item.results.length
      ? item.results.map((r, ri) => `   [검색결과${ri + 1}] ${r.title} (${r.url})\n   ${r.content}`).join('\n')
      : '   (검색 결과 없음)';
    return `${i + 1}. ${item.name}\n   관련 웹 검색 결과:\n${searchBlock}`;
  }).join('\n\n');

  const prompt = `당신은 건설 특허공법(POUR) 시장의 경쟁사 동향을 분석해 실무진에게 구체적인 대응 방안을 제안하는 애널리스트입니다.
아래는 주요 경쟁사 목록과, 각 업체명으로 검색한 최근 웹 검색 결과(제목·출처·요약)입니다.

⚠ 중요: 회사명만으로 검색했기 때문에, 검색 결과 중 상당수가 해당 업체와 실제로 무관한 내용일
수 있습니다(동명이인·동명업체, 완전히 다른 주제의 뉴스나 블로그 글 등). 각 업체별로 먼저 검색
결과 하나하나가 "실제로 이 건설 경쟁사에 대한 내용이 맞는지" 판단한 뒤, 명백히 무관한 결과는
완전히 무시하고 절대로 summary·action·sources에 반영하지 마세요.

각 업체별로:
(1) 실제로 관련 있는 검색 결과에 나타난 최신 소식(신규 특허, 수주, 사업 확장, 기술 인증 등)만 요약하고,
(2) 그 소식에 비추어 우리(브릿지원/POUR) 실무진이 취하면 좋을 구체적인 대응 방안을 함께 제시하세요.

[경쟁사 및 관련 검색 결과]
${companyText}

지시사항:
- summary·action 모두 "실제로 관련 있다고 판단한" 검색 결과만 근거로 사용하세요 — 무관한 결과나, 검색 결과에 없는 내용을 지어내지 마세요.
- 관련 있는 검색 결과가 하나도 없으면(모두 무관하거나 "검색 결과 없음"이면), summary에는 "최근 특이 동향이 검색되지 않았습니다."라고만 쓰고, action에는 "특이 조치 불필요, 지속 모니터링"처럼 일반적인 수준으로만 작성하세요. 이때 used_indices는 빈 배열 []로 남기세요.
- action은 "점검 필요"·"확인 필요" 같은 막연한 말이 아니라, 관련 있는 검색 결과에 나온 구체적인 사실(어떤 공법·지역·수주 등)을 근거로 실무진이 바로 참고할 수 있는 수준으로 1~2문장으로 작성하세요.
- used_indices에는 실제로 summary·action 작성에 사용한(=관련 있다고 판단한) 검색결과 번호만 배열로 적으세요(예: [1, 3]). 무관하다고 판단해 사용하지 않은 번호는 절대 포함하지 마세요. 하나도 없으면 [].
- note에는 used_indices에 해당하는 내용을 간단히 요약하거나, 없으면 "관련 검색 결과 없음"이라고 쓰세요.
- 존댓말을 사용하세요.
- 아래 JSON 배열 형식으로만 답하세요. 다른 설명 문장은 붙이지 마세요.
[
  { "index": 1, "summary": "업체별 최신 동향 요약 (한국어, 존댓말, 1~2문장)", "action": "구체적인 대응 방안 (한국어, 존댓말, 1~2문장)", "used_indices": [1, 3], "note": "참고한 검색 결과 요약 또는 '관련 검색 결과 없음'" }
]`;

  let text;
  try {
    text = await callAiProvider(prompt, 1536);
  } catch (e) {
    console.warn(`  - ⚠ 경쟁사 동향 생성 실패(건너뜀): ${e.message}`);
    return [];
  }

  const parsed = extractJsonArray(text);
  if (!Array.isArray(parsed)) {
    console.warn('  - ⚠ 경쟁사 동향 응답 파싱 실패(건너뜀)');
    return [];
  }

  return parsed.map(item => {
    const idx = Number(item.index) - 1;
    const entry = searchPerCompany[idx];
    if (!entry || !item.summary) return null;
    // [v10] AI가 실제로 관련 있다고 판단해 used_indices에 적은 검색결과만 출처로 남깁니다
    // (Joe 피드백: 관련 없는 인스타그램·나무위키 등이 출처로 뜨는 문제 — 원본 검색 결과
    // 전체가 아니라 AI가 실제로 인용한 것만 sources에 포함시켜 해결).
    const usedIdx = Array.isArray(item.used_indices)
      ? item.used_indices.map(n => Number(n) - 1).filter(n => Number.isInteger(n) && n >= 0 && n < entry.results.length)
      : [];
    return {
      company: entry.name,
      summary: String(item.summary).trim(),
      action: item.action ? String(item.action).trim() : null,
      note: item.note ? String(item.note).trim() : null,
      sources: usedIdx.map(i => ({ title: entry.results[i].title, url: entry.results[i].url })),
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
// 4c. [v11 추가, v12에서 세부 차원별 분류 + AI 코멘트 확장] 고객여정 퍼널 — B2B사업운영팀
//     "여정_최종" 시트를 문의(L2)~낙찰(L5) 단계로 집계합니다. 집계 자체는 숫자를 "계산"만
//     할 뿐, AI 호출이나 추측이 전혀 없습니다(단계·처리상태 컬럼 값을 그대로 규칙 기반으로
//     분류). AI는 그 계산 결과를 문장으로 요약하는 별도 단계(callClaudeForJourneyFunnel)에서만
//     쓰입니다 — 다른 카드들과 동일한 안전장치입니다.
//
//     분류 기준(현장+공종 단위 "케이스"별로 가장 진행된 상태 1개만 선택):
//       1. l2_only            — 문의(L2)에서 끝남
//       2. l3_pending         — 컨설팅/PT(L3)까지 진행, 이후 상태 불명
//       3. l4_pending         — 공고(L4) 진행중, 결과 대기
//       4. lost_bid_failed    — 유찰/공고취소로 수주 자체가 무산
//       5. lost_to_competitor — 처리상태="타공법낙찰" (경쟁사/타 공법으로 낙찰)
//       6. won                — 단계=L5 & 처리상태="완료" (POUR 낙찰 성공)
//     ※ 주의: "타공법낙찰" 행의 '업체명'은 실제 낙찰받은 경쟁사명이 아니라 우리 쪽
//       협력사(시공사)명입니다 — 어느 경쟁사가 낙찰받았는지는 이 시트만으로는 알 수
//       없으므로(외부 POUR 공고문 데이터와 별도 교차 매칭 필요) 여기서는 "타사로
//       넘어간 건수"까지만 집계합니다.
//     ※ 업체명에 "테스트"가 포함된 행(더미 데이터)은 집계에서 제외합니다.
//
//     [v12 추가 — 2026-08-11] Joe 요청("연결할 수 있는 결과 및 인사이트 도출이 안되는데
//     어떻게 안될까요") — 전체 총건수만으로는 "어디부터 손봐야 하는지"가 안 보인다는
//     피드백에 따라 두 가지를 추가했습니다.
//     (1) 지역별/공종별 세부 분류 — 케이스별 주소에서 광역 지역(시/도)을, 공종명에서 대표
//         공종(첫 '+' 앞부분)을 뽑아 이탈률(l2_only+l3_pending 비중)·POUR 낙찰률을 지역·공종
//         단위로 재집계합니다(표본 15건 미만인 지역/공종은 우연에 가까워 노출하지 않음).
//     (2) journey_funnel_commentary — 위 (1)에서 계산된 수치(문장이 아니라 숫자)만 근거로
//         AI에게 "어디부터 확인해볼 만한지" 코멘트를 요청합니다. 다른 코멘트 기능과 동일하게
//         "왜" 이탈했는지는 이 데이터만으로 알 수 없다는 점을 프롬프트에 명시해, AI가 원인을
//         지어내지 않도록 합니다.
// ---------------------------------------------------------------------------
const JOURNEY_CATEGORIES = [
  { key: 'l2_only', label: '문의(L2)에서 끝남', priority: 1 },
  { key: 'l3_pending', label: '컨설팅/PT(L3)까지 진행 · 이후 미상', priority: 2 },
  { key: 'l4_pending', label: '공고(L4) 진행중 · 결과 대기', priority: 3 },
  { key: 'lost_bid_failed', label: '유찰/공고취소로 수주 무산', priority: 4 },
  { key: 'lost_to_competitor', label: '타사(타공법)로 낙찰', priority: 5 },
  { key: 'won', label: 'POUR 낙찰 성공', priority: 6 },
];
const JOURNEY_DROPOUT_KEYS = new Set(['l2_only', 'l3_pending']);
const JOURNEY_DIMENSION_MIN_SAMPLE = 15; // 표본이 이보다 적은 지역/공종은 노출하지 않음(우연 방지)

function classifyJourneyRow(stage, status) {
  if (status === '타공법낙찰') return 'lost_to_competitor';
  if (status === '유찰' || status === '공고취소') return 'lost_bid_failed';
  if (stage === 'L5' && status === '완료') return 'won';
  if (stage === 'L4') return 'l4_pending';
  if (stage === 'L3') return 'l3_pending';
  if (stage === 'L2') return 'l2_only';
  return null;
}

// 주소 첫 토큰(시/도)을 광역 단위로 정규화 — "서울특별시"/"서울" 모두 "서울"로 묶는 식.
const JOURNEY_REGION_MAP = {
  '서울특별시': '서울', '서울': '서울',
  '부산광역시': '부산', '대구광역시': '대구', '인천광역시': '인천',
  '광주광역시': '광주', '대전광역시': '대전', '울산광역시': '울산',
  '세종특별자치시': '세종', '세종시': '세종',
  '경기도': '경기', '경기': '경기',
  '강원특별자치도': '강원', '강원도': '강원',
  '충청북도': '충북', '충청남도': '충남',
  '전북특별자치도': '전북', '전라북도': '전북', '전라남도': '전남',
  '경상북도': '경북', '경상남도': '경남',
  '제주특별자치도': '제주', '제주도': '제주', '제주': '제주',
};
// [v12 수정] 일부 행의 '주소' 값이 원본 데이터 자체에 이상이 있어(예: 지역명이 중복
// 결합되어 "전남광주통합특별시 북구 전남광주통합특별시 북구 …"처럼 실제 존재하지 않는
// 지역명이 만들어짐) 첫 토큰을 그대로 지역명으로 쓰면 안 됩니다. 17개 광역 지역
// 화이트리스트에 없는 값은 전부 "기타/확인필요"로 묶어, 잘못된 지역명이 그대로 카드에
// 노출되지 않도록 합니다.
const JOURNEY_VALID_REGIONS = new Set(Object.values(JOURNEY_REGION_MAP));
function normalizeJourneyRegion(addr) {
  const first = (addr || '').trim().split(/\s+/)[0] || '';
  const mapped = JOURNEY_REGION_MAP[first] || first;
  return JOURNEY_VALID_REGIONS.has(mapped) ? mapped : '기타/확인필요';
}
// 공종명이 "균열보수및재도장+에폭시"처럼 '+'로 여러 개 묶인 경우 대표(첫) 공종만 사용.
function primaryJourneyWorktype(work) {
  const first = (work || '').split('+')[0].trim();
  return first || '기타';
}

function computeCustomerJourneyFunnel(journeyRows) {
  if (!journeyRows || journeyRows.length < 2) return null;

  const header = journeyRows[0];
  const idx = name => header.indexOf(name);
  // [v12 수정] 케이스 키를 '아파트ID' 대신 '아파트명+주소'(텍스트)로 바꿨습니다. 검증 중
  // 발견: '아파트ID' 값이 25자리 안팎의 매우 큰 숫자인데, 구글 시트/엑셀 내부적으로
  // 숫자(IEEE754 double)로 저장되어 15~17자리를 넘는 자릿수는 정밀도가 소실됩니다. 그
  // 결과 서로 다른 아파트 954개 중 329개(전체 행의 약 60%)가 실제로는 다른 단지인데도
  // 같은 아파트ID로 겹쳐 집계되는 것을 확인했습니다. 아파트명+주소는 텍스트라 이 문제가
  // 없어 훨씬 안정적입니다.
  const iAptName = idx('아파트명'), iWork = idx('공종명'), iStage = idx('단계'),
        iStatus = idx('처리상태'), iCompany = idx('업체명'), iAddr = idx('주소');

  if ([iAptName, iWork, iStage, iStatus, iCompany, iAddr].some(i => i < 0)) {
    console.warn('  - ⚠ 고객여정 시트에서 예상 컬럼을 찾지 못해 건너뜁니다(시트 구조 변경 가능성).');
    return null;
  }

  const priorityMap = {};
  JOURNEY_CATEGORIES.forEach(c => { priorityMap[c.key] = c.priority; });

  const best = new Map(); // case_key(아파트명+주소+공종명, 텍스트) -> { key, priority, region, worktype }
  let testExcluded = 0;
  let skippedNoCategory = 0;

  journeyRows.slice(1).forEach(r => {
    if (!r || r.length < 2) return;
    const company = (r[iCompany] || '').trim();
    if (company.includes('테스트')) { testExcluded++; return; }
    const aptName = (r[iAptName] || '').trim();
    const addr = (r[iAddr] || '').trim();
    const work = (r[iWork] || '').trim();
    if (!aptName || !addr) return;

    const stage = (r[iStage] || '').trim();
    const status = (r[iStatus] || '').trim();
    const catKey = classifyJourneyRow(stage, status);
    if (!catKey) { skippedNoCategory++; return; }

    const caseKey = `${aptName}__${addr}__${work}`;
    const p = priorityMap[catKey];
    const existing = best.get(caseKey);
    if (!existing || p > existing.priority) {
      best.set(caseKey, {
        key: catKey,
        priority: p,
        region: normalizeJourneyRegion(r[iAddr]),
        worktype: primaryJourneyWorktype(work),
      });
    }
  });

  const counts = {};
  JOURNEY_CATEGORIES.forEach(c => { counts[c.key] = 0; });
  best.forEach(v => { counts[v.key] = (counts[v.key] || 0) + 1; });

  const totalCases = best.size;
  const categories = JOURNEY_CATEGORIES.map(c => ({
    key: c.key,
    label: c.label,
    count: counts[c.key] || 0,
    pct: totalCases ? Number(((counts[c.key] || 0) / totalCases * 100).toFixed(1)) : 0,
  }));

  // [v12] 지역/공종 단위 세부 분류 — 이탈률(dropout_pct)·POUR 낙찰률(won_pct)을 함께 계산.
  function buildDimensionBreakdown(dimName) {
    const buckets = new Map();
    best.forEach(v => {
      const label = v[dimName];
      if (!buckets.has(label)) buckets.set(label, { total: 0, dropout: 0, won: 0, lostToCompetitor: 0 });
      const b = buckets.get(label);
      b.total++;
      if (JOURNEY_DROPOUT_KEYS.has(v.key)) b.dropout++;
      if (v.key === 'won') b.won++;
      if (v.key === 'lost_to_competitor') b.lostToCompetitor++;
    });
    return Array.from(buckets.entries())
      .map(([label, b]) => ({
        label,
        total: b.total,
        dropout: b.dropout,
        dropout_pct: b.total ? Number((b.dropout / b.total * 100).toFixed(1)) : 0,
        won: b.won,
        won_pct: b.total ? Number((b.won / b.total * 100).toFixed(1)) : 0,
        lost_to_competitor: b.lostToCompetitor,
      }))
      .filter(x => x.total >= JOURNEY_DIMENSION_MIN_SAMPLE)
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);
  }

  return {
    total_cases: totalCases,
    total_source_rows: journeyRows.length - 1,
    excluded_test_rows: testExcluded,
    skipped_rows_no_category: skippedNoCategory,
    categories,
    by_region: buildDimensionBreakdown('region'),
    by_worktype: buildDimensionBreakdown('worktype'),
    dimension_min_sample: JOURNEY_DIMENSION_MIN_SAMPLE,
  };
}

// [v12] 위에서 계산된 숫자만으로 AI에게 넘길 "이미 계산된 신호" 문장 목록을 만듭니다.
// (이 함수 자체는 문자열 포맷팅만 할 뿐 AI를 호출하지 않습니다.)
function buildJourneyFunnelHighlightLines(jf) {
  if (!jf) return [];
  const byKey = {};
  jf.categories.forEach(c => { byKey[c.key] = c; });
  const lines = [];
  lines.push(`전체 ${jf.total_cases}건 중 문의(L2)에서 끝난 건 ${byKey.l2_only.count}건(${byKey.l2_only.pct}%), 컨설팅/PT(L3)까지 진행했으나 이후 상태 불명인 건 ${byKey.l3_pending.count}건(${byKey.l3_pending.pct}%)입니다.`);
  lines.push(`공고(L4) 진행중 ${byKey.l4_pending.count}건, 유찰/공고취소로 수주 무산 ${byKey.lost_bid_failed.count}건, 타사(타공법)로 낙찰 ${byKey.lost_to_competitor.count}건, POUR 낙찰 성공 ${byKey.won.count}건(${byKey.won.pct}%)입니다.`);

  if (jf.by_region && jf.by_region.length) {
    // [v12 수정] "기타/확인필요"는 실제 지역이 아니라 주소 데이터 이상으로 판별 불가한
    // 케이스들이 모인 버킷이라, "이탈률 1위 지역"처럼 지역 성과 비교에는 절대 포함하지
    // 않습니다(포함하면 데이터 오류를 "그 지역의 특징"처럼 오인시킬 수 있음).
    const realRegions = jf.by_region.filter(r => r.label !== '기타/확인필요');
    if (realRegions.length) {
      const byDropout = [...realRegions].sort((a, b) => b.dropout_pct - a.dropout_pct)[0];
      lines.push(`지역별(표본 ${jf.dimension_min_sample}건 이상, "기타/확인필요" 제외)로 보면 ${byDropout.label} 지역의 이탈률(문의·컨설팅에서 멈춘 비율)이 ${byDropout.dropout_pct}%(${byDropout.total}건 중 ${byDropout.dropout}건)로 가장 높습니다.`);
      const byVolume = [...realRegions].sort((a, b) => b.total - a.total)[0];
      if (byVolume.label !== byDropout.label) {
        lines.push(`케이스 수가 가장 많은 지역은 ${byVolume.label}로 ${byVolume.total}건이며, 이 중 이탈률은 ${byVolume.dropout_pct}%, POUR 낙찰률은 ${byVolume.won_pct}%입니다.`);
      }
    }
    const unknownRegion = jf.by_region.find(r => r.label === '기타/확인필요');
    if (unknownRegion) {
      lines.push(`※ 주소 데이터 자체에 이상이 있어(지역명이 중복 결합되는 등) 지역을 정확히 판별할 수 없는 케이스가 ${unknownRegion.total}건 있습니다 — 원본 시트의 주소 필드 오류로 보이며 실제 지역 특성과는 무관합니다.`);
    }
  }
  if (jf.by_worktype && jf.by_worktype.length) {
    // [v12] 검증 중 발견: '공종명' 표기가 문의(L2·L3) 단계와 공고·낙찰(L4·L5) 단계에서
    // 서로 다른 용어를 쓰는 사례가 있습니다(예: "슁글"은 L2·L3에만, "싱글"은 L3·L4·L5에만
    // 등장 / "균열보수및재도장"은 L2·L3에만, "재도장"은 L4·L5에만 등장). 즉 같은 작업이
    // 단계에 따라 다른 이름으로 기록됐을 가능성이 있어, 공종별 이탈률·낙찰률 차이가 실제
    // 공종 성과 차이인지 표기 차이인지 구분할 수 없습니다. 그래서 "어느 공종이 낫다/못하다"
    // 식 결론은 만들지 않고, 이 사실 자체만 신호로 남깁니다(AI에게도 결론 내리지 말라고
    // 프롬프트에 명시).
    lines.push(`※ '공종명' 표기가 문의·컨설팅(L2·L3) 단계와 공고·낙찰(L4·L5) 단계에서 서로 다른 용어를 쓰는 사례가 확인되었습니다(예: "슁글"은 초기 단계에만, "싱글"은 후기 단계에만 등장 / "균열보수및재도장"은 초기 단계에만, "재도장"은 후기 단계에만 등장). 그래서 공종별 이탈률·낙찰률 수치는 실제 공종 간 성과 차이인지 단계별 표기 차이인지 이 데이터만으로 구분할 수 없어, 공종별로는 결론을 내리지 않습니다.`);
  }
  return lines;
}

// [v12] callClaudeForSignals()는 "전월 대비" 같은 비교 문구를 전제로 하는 프롬프트라, 스냅샷
// 성격의 퍼널 집계에는 맞지 않아 별도 함수로 둡니다. 안전장치(신호만 근거로 사용, 추측 금지,
// 신호 0건이면 API 호출 생략)는 동일합니다.
async function callClaudeForJourneyFunnel(lines) {
  if (!lines || lines.length === 0) {
    return { commentary: null, model: null };
  }
  const signalText = lines.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const prompt = `당신은 건설 특허공법(POUR) 영업의 고객여정(문의→컨설팅→공고→낙찰) 퍼널 데이터를 분석해, 어디서 이탈이 발생하고 실무진이 우선 어디부터 확인해봐야 하는지 보고하는 애널리스트입니다.
아래는 이미 규칙 기반으로 계산된 고객여정 퍼널 집계 결과입니다.

[집계 결과]
${signalText}

지시사항:
- 위 집계 결과에 있는 수치만 근거로 사용하세요. 목록에 없는 원인이나 배경을 추측해서 만들어내지 마세요.
- 이탈(문의·컨설팅에서 멈추는 것) 비중이 큰 지역을 짚어주고, 실무진이 우선적으로 들여다볼 만한 지점을 제안하세요.
- 다만 "왜" 이탈이 발생했는지는 이 데이터만으로 알 수 없으므로 원인을 단정하지 말고 "확인 필요"로 표현하세요.
- 집계 결과에 "※"로 시작하는 데이터 품질 관련 안내(주소 판별 불가, 공종명 표기 불일치 등)가 있다면, 그 내용은 있는 그대로 전달하되 거기서 "어느 지역/공종이 더 낫다"는 식의 결론을 만들어내지 마세요 — 특히 공종별 수치는 표기 불일치 때문에 신뢰할 수 없다는 점이 명시된 경우, 공종에 대해서는 어떤 순위나 결론도 내리지 마세요.
- 과장하지 말고 사실 위주로, 실무진이 바로 읽을 수 있도록 문장 단위로 끊어 한국어로 3~5문장 이내로 작성하세요.
- 존댓말을 사용하세요.`;

  const commentary = await callAiProvider(prompt, 768);
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

  // [v9] "웹 검색 기반 대응 방안"(highlight_actions_ai, v7)은 Joe 요청으로 폐지하고
  // "경쟁사 동향"(competitor_watch_trends, v8)으로 대체했습니다 — 그날그날 바뀌는 상위
  // 3개 하이라이트보다, 지정된 5개 경쟁사의 실제 최신 동향이 더 유용하다는 피드백입니다.
  // (generateWebInformedActions() 함수 자체는 재사용 가능성을 위해 남겨두되 더 이상 호출하지 않습니다.)
  console.log('[5/9] 주요 경쟁사 5개사 최신 동향(뉴스) 생성 중...');
  const competitorWatch = await generateCompetitorWatchTrends(COMPETITOR_WATCHLIST);
  console.log(competitorWatch.length ? `  - ${competitorWatch.length}건 생성됨` : '  - 생성 안 됨(검색/AI 호출 실패)');

  // [v11 추가] 고객여정 퍼널 — 별도 시트/별도 실패 지점이라 나머지 파이프라인에 영향 없도록
  // try/catch로 감쌉니다. 실패하면(시트 접근 불가 등) customer_journey_funnel은 null로 저장되고
  // 대시보드는 이 카드만 조용히 숨깁니다.
  console.log('[고객여정] "여정_최종" 시트에서 L2~L5 퍼널 집계 중...');
  let journeyFunnel = null;
  let journeyCommentaryResult = { commentary: null, model: null };
  try {
    const journeyCsv = await fetchCsv(JOURNEY_GID, JOURNEY_SHEET_ID);
    const journeyRows = parseCsv(journeyCsv);
    journeyFunnel = computeCustomerJourneyFunnel(journeyRows);
    console.log(journeyFunnel
      ? `  - 케이스 ${journeyFunnel.total_cases}건 집계됨(원본 ${journeyFunnel.total_source_rows}행, 테스트데이터 ${journeyFunnel.excluded_test_rows}행 제외)`
      : '  - 집계 실패(시트 구조 확인 필요) — 건너뜀');
    if (journeyFunnel) {
      console.log('  - AI 코멘트(지역·공종별 이탈 패턴) 생성 중...');
      const jfLines = buildJourneyFunnelHighlightLines(journeyFunnel);
      journeyCommentaryResult = await callClaudeForJourneyFunnel(jfLines);
      console.log(journeyCommentaryResult.commentary ? '  - 코멘트 생성됨' : '  - 코멘트 생성 안 됨(API 호출 실패)');
    }
  } catch (e) {
    console.warn(`  - ⚠ 고객여정 시트 접근/분석 실패(건너뜀): ${e.message}`);
  }

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

  // [v13 추가] 전년동월 비교 — 2025년 정적 참고 데이터(data/reference-2025-daily.json)가 있을
  // 때만 계산합니다(파일이 없거나 작년 같은 달 데이터가 없으면 조용히 건너뜀).
  console.log('[전년비교] 이번 달 vs 작년 같은 달 비교 중...');
  const ref2025 = loadReference2025();
  const yctx = computeYoySignals(ds, ref2025);
  let yoyResult = { commentary: null, model: null };
  if (yctx.hasEnoughData) {
    console.log(`  - 이번 달 ${yctx.latestYm} vs 작년 같은 달 ${yctx.yoyYm} / 신호 ${yctx.highlights.length}건`);
    if (yctx.comparisonNote) console.log(`  - ⚠ ${yctx.comparisonNote}`);
    yoyResult = await callClaudeForSignals(yctx.highlights, {
      latestYm: yctx.latestYm,
      prevYm: yctx.yoyYm,
      roleDesc: '당신은 건설 특허공법(POUR) 시장의 공고문 데이터를 분석해, "작년 같은 기간 대비" 관점에서 실무진에게 보고하는 애널리스트입니다.',
      noSignalText: '작년 같은 달 대비 뚜렷한 변동 신호가 감지되지 않았습니다. 특이사항 없이 안정적인 흐름입니다.',
      extraContext: yctx.comparisonNote ? `※ 비교 기준: ${yctx.comparisonNote}` : null,
      periodOverride: `"이번 달(${yctx.latestYm})"을 "작년 같은 달(${yctx.yoyYm})"과`,
    });
  } else {
    console.log(`  - 건너뜀 (${yctx.noDataReason || '참고 데이터 없음'})`);
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

    // --- [v8, v9에서 강화] 주요 경쟁사 5개사(4A시스템·금영ENC·피엠씨·미래피앤씨·수퍼크랙실)의
    //     최신 동향(뉴스) — 그날의 하이라이트 상위 3건 여부와 무관하게 매일 5개사 전원 대상,
    //     Tavily topic=news + 최근 1개월 필터로 실제 최신 뉴스 위주 검색 (실패/미검색 시 빈 배열).
    //     (v7의 highlight_actions_ai/web_action_model 필드는 Joe 요청으로 v9에서 폐지되었습니다.)
    competitor_watch_trends: competitorWatch,
    competitor_watch_model: competitorWatch.length ? MODEL : null,

    // --- [v11 추가, v12에서 지역·공종별 세부 분류 추가] 고객여정 퍼널 — "여정_최종" 시트
    //     (B2B사업운영팀 관리) 기준, 문의(L2)부터 낙찰(L5)까지 현장+공종 단위 케이스를 6개
    //     유형으로 분류한 집계(by_region/by_worktype 포함)입니다. AI가 개입하지 않는 순수
    //     규칙 기반 집계이며, 시트 접근 실패 시 null(대시보드는 카드를 숨김)입니다.
    customer_journey_funnel: journeyFunnel,
    // --- [v12 추가] 위 집계 수치만 근거로 생성한 AI 코멘트(어디서 이탈이 큰지, 어디부터
    //     확인해볼 만한지) — 신호가 없으면(journeyFunnel null) API 호출 자체를 생략합니다.
    journey_funnel_commentary: journeyCommentaryResult.commentary,
    journey_funnel_model: journeyCommentaryResult.model,

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

    // --- [v13 추가] 전년동월(이번 달 vs 작년 같은 달) 비교 — data/reference-2025-daily.json
    //     (정적 참고 데이터, 2025-01~12월 커버)이 있을 때만 채워지고, 없으면 전부 null/[]
    //     입니다. 구분(POUR/다특허/DO/CNC/일반/타사)·공종 단위만 지원하며 업체별 비교는
    //     이번에는 포함하지 않았습니다.
    yoy_period: yctx.hasEnoughData ? {
      latest: yctx.latestYm, yoy: yctx.yoyYm,
      comparison_note: yctx.comparisonNote,
    } : null,
    yoy_model: yoyResult.model,
    yoy_highlights: yctx.hasEnoughData ? yctx.highlights.slice(0, 8).map(h => ({
      text: h.text, type: h.type, direction: h.direction, subject: h.subject || null,
      action: actionFor(h),
    })) : [],
    yoy_commentary: yoyResult.commentary,

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
  extractJsonArray, generateWebInformedActions, callTavilySearch, buildSearchQueryFor,
  COMPETITOR_WATCHLIST, buildCompetitorWatchQuery, generateCompetitorWatchTrends,
  JOURNEY_CATEGORIES, classifyJourneyRow, computeCustomerJourneyFunnel,
  normalizeJourneyRegion, primaryJourneyWorktype, buildJourneyFunnelHighlightLines,
  callClaudeForJourneyFunnel,
  loadReference2025, computeYoySignals,
};
