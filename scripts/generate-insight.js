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
    // [v14 추가] 업체별 재식별 데이터(company_daily) — 2025년 "특허(N)" 시트(특허번호→업체명
    // 매핑표)로 타사 공고를 업체별로 재식별한 정적 데이터. 구버전 참고 파일(이 필드가 없는
    // 파일)이면 null로 두고, 업체별 예상 점유율 계산만 건너뜁니다(나머지는 그대로 동작).
    const companyDaily = parsed.company_daily || null;
    return { catDaily, worktypeDaily, companyDaily, source: parsed.source || null };
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
// 3c. [v14 추가 — 2026-08-12] 예상 결과(간단 추정) — Joe 요청("혹시 예상 되는 결과 도출도
//     가능하니" → 확인 결과 3가지: (1) 이번 달/올해 남은 기간 예상 공고 건수, (2) 업체별·
//     공종별 예상 점유율 변화, (3) 고객여정 퍼널 예상 낙찰 건수).
//     ⚠ 셋 다 "과거 패턴을 그대로 미래에 연장"하는 단순 추정이며 통계적 예측 모델이
//     아닙니다. safety_protocol(임의로 추측·단정하지 않음)에 따라 방법론을 결과에 그대로
//     남기고, AI 코멘트에도 "추정치"라는 점과 표본 크기를 항상 함께 언급하도록 지시합니다.
// ---------------------------------------------------------------------------

// dailyRecords(date -> {field: count} 형태, dailyMap/worktypeDailyMap/COMPANY_DAILY(2026)와
// ref.catDaily/worktypeDaily/companyDaily(2025) 모두 동일 구조)에서 특정 연도의
// 1/1 ~ endYm(해당 연도)/endDay까지 누적 합산합니다("연초부터 지금까지" 비교용).
function sumFieldsForYtd(dailyRecords, year, endYm, endDay, fields) {
  const out = {};
  fields.forEach(f => { out[f] = 0; });
  Object.keys(dailyRecords).forEach(date => {
    if (!date.startsWith(String(year))) return;
    const ym = date.slice(0, 7);
    if (ym > endYm) return;
    if (ym === endYm) {
      const day = Number(date.slice(8, 10));
      if (day > endDay) return;
    }
    const rec = dailyRecords[date];
    fields.forEach(f => { out[f] += (rec[f] || 0); });
  });
  return out;
}

// [1] 이번 달 / 올해 남은 기간 예상 공고 건수
//  - 이번 달: 2025년 같은 달의 "1일~오늘까지 누적 비중"으로 역산합니다(월내 쏠림 반영 —
//    예: 작년 이 달이 11일까지 전체의 60%가 나왔다면, 올해도 비슷하게 쏠렸을 것으로 보고
//    올해 11일까지 실적을 0.6으로 나눠 월말 예상치를 구함). 2025년 같은 달 데이터가 없으면
//    단순 일할계산(경과일 ÷ 이번달 총일수)으로 대체합니다.
//  - 남은 달(다음 달~12월): 이미 끝난 2026년 각 달의 "전년 동월 대비 증감률" 평균을 구해,
//    아직 오지 않은 달의 2025년 실적에 그대로 곱해 추정합니다.
function computeMonthlyForecast(ds, ref) {
  const { dailyMap, DATA } = ds;
  if (!DATA.date_max) return null;
  const latestYm = monthKey(DATA.date_max);
  const [y, m] = latestYm.split('-').map(Number);
  const latestDay = Number(DATA.date_max.slice(8, 10));
  const totalDaysThisMonth = daysInMonth(latestYm);
  const isMonthComplete = latestDay >= totalDaysThisMonth;

  const CAT_FIELDS = MAIN_CATS.concat('total');
  const soFarThisMonth = sumFieldsForMonth(dailyMap, latestYm, null, CAT_FIELDS);

  let thisMonthForecast = null;
  let thisMonthMethod = null;
  if (isMonthComplete) {
    thisMonthForecast = soFarThisMonth;
    thisMonthMethod = 'actual'; // 이미 끝난 달 — 예측이 아니라 실측치
  } else if (ref) {
    const yoyYm = `${y - 1}-${String(m).padStart(2, '0')}`;
    const yoyDayCap = sumFieldsForMonth(ref.catDaily, yoyYm, latestDay, CAT_FIELDS);
    const yoyFullMonth = sumFieldsForMonth(ref.catDaily, yoyYm, null, CAT_FIELDS);
    if (yoyFullMonth.total > 0 && yoyDayCap.total > 0) {
      const prop = yoyDayCap.total / yoyFullMonth.total;
      thisMonthForecast = {};
      CAT_FIELDS.forEach(f => { thisMonthForecast[f] = Math.round(soFarThisMonth[f] / prop); });
      thisMonthMethod = 'yoy_day_pattern';
    }
  }
  if (!thisMonthForecast && !isMonthComplete) {
    const prop = latestDay / totalDaysThisMonth; // 2025년 참고 데이터가 없을 때의 대체 방법
    thisMonthForecast = {};
    CAT_FIELDS.forEach(f => { thisMonthForecast[f] = Math.round(soFarThisMonth[f] / prop); });
    thisMonthMethod = 'flat_runrate';
  }
  // 참고용 하한선 — "yoy_day_pattern"은 작년 단 1개년치 월내 분포 하나에만 의존하는 값이라,
  // 그 달이 우연히 월말에 쏠린 달이었다면 예상치가 크게 부풀 수 있습니다(2025-08 실제 사례:
  // 11일까지 25.6%만 발생 → 예상치가 실적의 약 3.9배). 항상 단순 일할계산(run-rate)도 함께
  // 계산해 두 값 사이를 "범위"로 보여줘, 하나의 숫자만 보고 과신하지 않도록 합니다.
  let thisMonthForecastRunrate = null;
  if (!isMonthComplete) {
    const flatProp = latestDay / totalDaysThisMonth;
    thisMonthForecastRunrate = {};
    CAT_FIELDS.forEach(f => { thisMonthForecastRunrate[f] = Math.round(soFarThisMonth[f] / flatProp); });
  }

  let restOfYearForecastTotal = null;
  let restOfYearMonths = [];
  let avgGrowthPct = null;
  let growthSampleMonths = 0;
  if (ref) {
    const completedMonths = [];
    for (let mi = 1; mi < m; mi++) {
      const ym2026 = `${y}-${String(mi).padStart(2, '0')}`;
      if (!Object.keys(dailyMap).some(d => d.startsWith(ym2026))) continue; // 이 달 데이터 자체가 없으면 제외
      const ym2025 = `${y - 1}-${String(mi).padStart(2, '0')}`;
      const actual2026 = sumFieldsForMonth(dailyMap, ym2026, null, ['total']).total;
      const actual2025 = sumFieldsForMonth(ref.catDaily, ym2025, null, ['total']).total;
      if (actual2025 >= MONTHLY_MIN_BASE) {
        completedMonths.push({ ym2026, actual2026, actual2025, growth: (actual2026 - actual2025) / actual2025 });
      }
    }
    growthSampleMonths = completedMonths.length;
    if (completedMonths.length > 0) {
      avgGrowthPct = completedMonths.reduce((s, x) => s + x.growth, 0) / completedMonths.length * 100;
      const growthRatio = 1 + avgGrowthPct / 100;
      let sumRest = 0;
      for (let mi = m + 1; mi <= 12; mi++) {
        const ym2025 = `${y - 1}-${String(mi).padStart(2, '0')}`;
        const actual2025 = sumFieldsForMonth(ref.catDaily, ym2025, null, ['total']).total;
        if (actual2025 > 0) {
          const forecastM = Math.round(actual2025 * growthRatio);
          restOfYearMonths.push({ ym: `${y}-${String(mi).padStart(2, '0')}`, forecast: forecastM });
          sumRest += forecastM;
        }
      }
      restOfYearForecastTotal = sumRest;
    }
  }

  let yearTotalForecast = null;
  if (thisMonthForecast && (m === 12 || restOfYearForecastTotal != null)) {
    let elapsedActual = 0;
    for (let mi = 1; mi < m; mi++) {
      const ym2026 = `${y}-${String(mi).padStart(2, '0')}`;
      elapsedActual += sumFieldsForMonth(dailyMap, ym2026, null, ['total']).total;
    }
    yearTotalForecast = elapsedActual + thisMonthForecast.total + (restOfYearForecastTotal || 0);
  }

  return {
    latestYm, latestDay, totalDaysThisMonth, isMonthComplete,
    soFarThisMonth, thisMonthForecast, thisMonthMethod, thisMonthForecastRunrate,
    avgGrowthPct: avgGrowthPct != null ? Number(avgGrowthPct.toFixed(1)) : null,
    growthSampleMonths,
    restOfYearForecastTotal, restOfYearMonths,
    yearTotalForecast,
  };
}

// [2] 업체별/공종별 예상 점유율 변화 — "연초(1/1)~오늘"과 "작년 같은 기간(1/1~같은 월/일)"의
// 점유율(구성비)을 비교해 변화 방향(%p)을 구하고, 그 변화 속도가 남은 기간에도 그대로
// 이어진다고 가정할 때의 연말 예상 점유율을 선형으로 추정합니다. 표본이 작은 항목·변화폭이
// 1%p 미만인 항목은 우연/노이즈에 가까워 제외합니다.
const SHARE_FORECAST_MIN_BASE = 20; // 비교 대상 그룹(구분/공종/업체) 합계가 이보다 작으면 그룹 전체를 건너뜀
const SHARE_FORECAST_MIN_FIELD = 5; // 개별 항목 합계가 두 기간 모두 이보다 작으면 그 항목만 제외
function computeShareForecastGroup(cur2026Dict, ref2025Dict, fields, latestYm, latestDay, groupLabel) {
  const y = Number(latestYm.slice(0, 4));
  const yoyYm = `${y - 1}-${latestYm.slice(5, 7)}`;
  const cur = sumFieldsForYtd(cur2026Dict, y, latestYm, latestDay, fields);
  const past = sumFieldsForYtd(ref2025Dict, y - 1, yoyYm, latestDay, fields);
  const curTotal = fields.reduce((s, f) => s + cur[f], 0);
  const pastTotal = fields.reduce((s, f) => s + past[f], 0);
  if (curTotal < SHARE_FORECAST_MIN_BASE || pastTotal < SHARE_FORECAST_MIN_BASE) return [];

  function dayOfYear(ym, day) {
    const mm = Number(ym.slice(5, 7));
    let doy = day;
    for (let i = 1; i < mm; i++) doy += daysInMonth(`${ym.slice(0, 4)}-${String(i).padStart(2, '0')}`);
    return doy;
  }
  const elapsed = dayOfYear(latestYm, latestDay) / 365;
  const remaining = 1 - elapsed;

  const rows = [];
  fields.forEach(f => {
    if ((past[f] || 0) < SHARE_FORECAST_MIN_FIELD && (cur[f] || 0) < SHARE_FORECAST_MIN_FIELD) return;
    const shareCur = curTotal ? cur[f] / curTotal * 100 : 0;
    const sharePast = pastTotal ? past[f] / pastTotal * 100 : 0;
    const diff = shareCur - sharePast;
    if (Math.abs(diff) < 1) return; // 1%p 미만 변화는 노이즈로 보고 제외
    const projectedRaw = elapsed > 0 ? shareCur + diff * (remaining / elapsed) : shareCur;
    const projected = Math.max(0, Math.min(100, projectedRaw));
    rows.push({
      group: groupLabel, field: f,
      share_now: Number(shareCur.toFixed(1)),
      share_year_ago: Number(sharePast.toFixed(1)),
      diff_pct_point: Number(diff.toFixed(1)),
      projected_year_end_share: Number(projected.toFixed(1)),
      base_now: cur[f], base_year_ago: past[f],
    });
  });
  rows.sort((a, b) => Math.abs(b.diff_pct_point) - Math.abs(a.diff_pct_point));
  return rows.slice(0, 6);
}

function computeShareForecast(ds, ref) {
  if (!ref || !ds.DATA.date_max) return { hasEnoughData: false, rows: [] };
  const latestYm = monthKey(ds.DATA.date_max);
  const latestDay = Number(ds.DATA.date_max.slice(8, 10));
  const rows = [];
  rows.push(...computeShareForecastGroup(ds.dailyMap, ref.catDaily, MAIN_CATS, latestYm, latestDay, '구분'));
  rows.push(...computeShareForecastGroup(ds.worktypeDailyMap, ref.worktypeDaily, TREND_WORKTYPES, latestYm, latestDay, '공종'));
  if (ref.companyDaily) {
    rows.push(...computeShareForecastGroup(ds.COMPANY_DAILY, ref.companyDaily, ds.COMPANY_NAMES, latestYm, latestDay, '업체'));
  }
  return { hasEnoughData: rows.length > 0, latestYm, latestDay, rows };
}

// [3] 고객여정 퍼널 예상 낙찰 건수 — "공고(L4) 진행중·결과 대기"(l4_pending) 건에, 이미
// 결과가 난 케이스(낙찰/타사낙찰/유찰)의 과거 비율을 그대로 적용해 앞으로 추가로 발생할
// 것으로 예상되는 낙찰 건수를 추정합니다. l3_pending(컨설팅 이후 미상)은 이미 사실상
// 이탈로 취급하고 있어(JOURNEY_DROPOUT_KEYS) 여기서도 "진행중인 파이프라인"에 포함하지
// 않습니다.
const JOURNEY_WIN_FORECAST_MIN_SAMPLE = 10; // 결과가 이미 난 건(closedTotal)이 이보다 적으면 비율 추정 생략
function computeJourneyWinForecast(jf) {
  if (!jf) return null;
  const byKey = {};
  jf.categories.forEach(c => { byKey[c.key] = c.count; });
  const won = byKey.won || 0;
  const lostToCompetitor = byKey.lost_to_competitor || 0;
  const lostBidFailed = byKey.lost_bid_failed || 0;
  const l4Pending = byKey.l4_pending || 0;
  const closedTotal = won + lostToCompetitor + lostBidFailed;

  if (closedTotal < JOURNEY_WIN_FORECAST_MIN_SAMPLE) {
    return { hasEnoughData: false, closedTotal, l4Pending, won, lostToCompetitor, lostBidFailed };
  }
  const winRate = won / closedTotal;
  const lossRate = lostToCompetitor / closedTotal;
  const expectedAdditionalWins = Math.round(l4Pending * winRate);
  const expectedAdditionalLosses = Math.round(l4Pending * lossRate);
  const expectedAdditionalBidFail = Math.max(0, l4Pending - expectedAdditionalWins - expectedAdditionalLosses);

  return {
    hasEnoughData: true,
    closedTotal, l4Pending, won, lostToCompetitor, lostBidFailed,
    win_rate_pct: Number((winRate * 100).toFixed(1)),
    expected_additional_wins: expectedAdditionalWins,
    expected_additional_losses: expectedAdditionalLosses,
    expected_additional_bid_fail: expectedAdditionalBidFail,
    expected_total_wins: won + expectedAdditionalWins,
  };
}

// 위 [1][2][3]에서 계산된 숫자만으로 AI에게 넘길 "이미 계산된 예상치" 문장 목록을 만듭니다.
// (문자열 포맷팅만 할 뿐 AI를 호출하지 않습니다 — 다른 카드들과 동일한 안전장치.)
function buildForecastHighlightLines(monthlyFc, shareFc, journeyFc) {
  const lines = [];
  if (monthlyFc && monthlyFc.thisMonthForecast && !monthlyFc.isMonthComplete) {
    const methodLabel = { yoy_day_pattern: '작년 같은 달의 날짜별 누적 패턴', flat_runrate: '단순 일할계산' }[monthlyFc.thisMonthMethod] || '';
    const rr = monthlyFc.thisMonthForecastRunrate;
    const yp = monthlyFc.thisMonthMethod === 'yoy_day_pattern' ? monthlyFc.thisMonthForecast.total : null;
    if (yp != null && rr && Math.abs(yp - rr.total) / Math.max(1, rr.total) > 0.2) {
      // 두 방법 값이 20% 이상 차이나면 하나의 숫자로 단정하지 않고 범위로 제시(작년 1개년치
      // 월내 분포에만 의존하는 값은 그 달이 우연히 쏠렸으면 과대·과소 추정될 수 있음).
      const lo = Math.min(yp, rr.total), hi = Math.max(yp, rr.total);
      lines.push(`이번 달(${monthlyFc.latestYm}) 전체 공고 건수는 ${monthlyFc.latestDay}일까지 ${monthlyFc.soFarThisMonth.total}건 집계됐습니다. 단순 일할계산으로는 약 ${rr.total}건, ${methodLabel} 기준으로는 약 ${yp}건으로 추정 방법에 따라 차이가 커서(작년 데이터 1개년치에만 의존), 월말까지 대략 ${lo}~${hi}건 사이로 추정됩니다(추정치, 범위로 해석 필요).`);
    } else {
      lines.push(`이번 달(${monthlyFc.latestYm}) 전체 공고 건수는 ${monthlyFc.latestDay}일까지 ${monthlyFc.soFarThisMonth.total}건 집계됐고, ${methodLabel} 기준으로 월말까지 약 ${monthlyFc.thisMonthForecast.total}건이 될 것으로 추정됩니다(추정치).`);
    }
  }
  if (monthlyFc && monthlyFc.yearTotalForecast != null) {
    lines.push(`2026년 전체로는(이미 지난 달 실측 + 이번 달·남은 달 추정 합산) 약 ${monthlyFc.yearTotalForecast}건이 될 것으로 추정됩니다(전년동월 대비 평균 ${monthlyFc.avgGrowthPct > 0 ? '+' : ''}${monthlyFc.avgGrowthPct}% 성장 추세를 남은 달에 그대로 적용, 비교 가능한 달 ${monthlyFc.growthSampleMonths}개월 기준 — 추정치).`);
  }
  (shareFc && shareFc.rows || []).forEach(r => {
    lines.push(`${r.group} "${r.field}"의 점유율은 작년 같은 기간 ${r.share_year_ago}% → 올해 현재 ${r.share_now}%로 ${r.diff_pct_point > 0 ? '▲' : '▼'}${Math.abs(r.diff_pct_point)}%p 변화했고, 이 추세가 이어진다면 연말엔 약 ${r.projected_year_end_share}%가 될 것으로 추정됩니다(선형 추세 가정 — 추정치, 표본 올해 ${r.base_now}건/작년 ${r.base_year_ago}건).`);
  });
  if (journeyFc && journeyFc.hasEnoughData) {
    lines.push(`고객여정 퍼널에서 현재 공고(L4) 진행중·결과 대기 중인 ${journeyFc.l4Pending}건 중, 과거 낙찰률(${journeyFc.win_rate_pct}%, 결과가 이미 난 ${journeyFc.closedTotal}건 기준)을 그대로 적용하면 약 ${journeyFc.expected_additional_wins}건이 추가로 POUR 낙찰될 것으로 예상됩니다(현재 누적 낙찰 ${journeyFc.won}건 + 예상 추가 ${journeyFc.expected_additional_wins}건 = 예상 총 ${journeyFc.expected_total_wins}건 — 추정치).`);
  } else if (journeyFc && !journeyFc.hasEnoughData) {
    lines.push(`고객여정 퍼널은 결과가 이미 난 케이스(${journeyFc.closedTotal}건)가 ${JOURNEY_WIN_FORECAST_MIN_SAMPLE}건 미만이라 낙찰률 기반 예상치를 산출하지 않았습니다.`);
  }
  return lines;
}

async function callClaudeForForecast(lines) {
  if (!lines || lines.length === 0) return { commentary: null, model: null };
  const signalText = lines.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const prompt = `당신은 건설 특허공법(POUR) 영업 데이터를 바탕으로 "앞으로 예상되는 결과"를 실무진에게 보고하는 애널리스트입니다.
아래는 이미 규칙 기반으로 계산된 예상치(추정치) 목록입니다. 각 항목엔 어떤 방법으로 추정했는지도 함께 적혀 있습니다.

[계산된 예상치 목록]
${signalText}

지시사항:
- 위 목록에 있는 수치와 방법론만 그대로 사용하세요. 목록에 없는 새로운 예상치나 원인을 지어내지 마세요.
- 이 수치들은 모두 "과거 패턴을 그대로 미래에 적용한 단순 추정치"이며 통계적 예측 모델이 아닙니다. 실제와 다를 수 있다는 점을 반드시 언급하세요.
- 표본이 적은(옆에 적힌 "건" 수가 작은) 항목은 신뢰도가 낮다는 점도 함께 짚어주세요.
- 과장하지 말고 사실 위주로, 실무진이 바로 읽을 수 있도록 문장 단위로 끊어 한국어로 3~5문장 이내로 작성하세요.
- 존댓말을 사용하세요.`;
  const commentary = await callAiProvider(prompt, 640);
  return { commentary, model: MODEL };
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
      // [v17 추가] "분기(3개월)"처럼 time_range가 지원하지 않는 임의 기간이 필요한 호출부는
      // start_date/end_date(YYYY-MM-DD)로 직접 범위를 지정할 수 있습니다.
      ...(opts.startDate ? { start_date: opts.startDate } : {}),
      ...(opts.endDate ? { end_date: opts.endDate } : {}),
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
  published_date: r.published_date || null,
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

// [v16 추가 — 2026-08-18] Joe 피드백("4A에 다른 정보가 있는 거 같은데") 확인 결과, "4A시스템"
// 검색 결과 중 실제로는 완전히 무관한 회사(자연과환경의 PC공법 기사)를 AI가 "관련 있다"고
// 잘못 판단해 그 회사명(4A시스템)으로 요약해버린 사례를 확인했습니다. 프롬프트로 "무관하면
// 걸러라"라고만 지시하는 방식은 약한 모델(gemini-3.5-flash-lite)에서 신뢰할 수 없어, AI에게
// 넘기기 전에 코드 단계에서 검색 결과 제목·본문에 회사명이 실제로 등장하는지 기계적으로 먼저
// 걸러내는 안전장치를 추가합니다. AI의 관련성 판단(프롬프트 지시)은 그 다음 단계에서 보조적
// 안전장치로 계속 유지합니다(동명이인 회사 등 문자열만으로는 못 거르는 경우 대비).
function resultMentionsCompany(result, name) {
  const norm = s => (s || '').toLowerCase().replace(/\s+/g, '');
  const n = norm(name);
  if (!n) return true;
  return norm(result.title).includes(n) || norm(result.content).includes(n);
}
function extractDateLikeStrings(text) {
  const found = [];
  if (!text) return found;
  let m;
  const reCompact = /(?:^|[^0-9])(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[^0-9]|$)/g;
  while ((m = reCompact.exec(text))) found.push(`${m[1]}-${m[2]}-${m[3]}`);
  const reSep = /(20\d{2})[.\-\/](0?[1-9]|1[0-2])[.\-\/](0?[1-9]|[12]\d|3[01])/g;
  while ((m = reSep.exec(text))) found.push(`${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`);
  const reKr = /(20\d{2})년\s*(0?[1-9]|1[0-2])?월?/g;
  while ((m = reKr.exec(text))) found.push(`${m[1]}-${String(m[2] || 1).padStart(2, '0')}-01`);
  return found;
}
function containsObviouslyOldDate(result, quarterStart) {
  const haystack = `${result.url || ''} ${result.title || ''}`;
  return extractDateLikeStrings(haystack).some(d => d < quarterStart);
}

// [v17 수정 — 2026-08-18] Joe 요청("주요 경쟁사 동향은 분기로 하자. 작년은 너무 오래 된
// 동향이야") — 기존에는 1차 검색을 topic=news + time_range=month(최근 1개월)로 좁혀
// 검색하고, 결과가 없으면 기간 제한이 전혀 없는 topic=general로 재검색했습니다. 이 "기간
// 제한 없는" 폴백 탓에 몇 년 전 기사처럼 지나치게 오래된 결과가 섞여 들어갈 수 있었던 것이
// Joe가 지적한 문제의 원인으로 보입니다. Tavily API는 time_range로 "분기(3개월)" 단위를
// 직접 지원하지 않아(day/week/month/year만 가능), 대신 start_date(YYYY-MM-DD)로 "오늘로부터
// 최근 90일"을 계산해 1차·폴백 검색 모두에 동일하게 적용합니다 — 폴백 검색도 더 이상 무제한
// 기간이 아니라 같은 분기(90일) 범위로 제한됩니다.
const COMPETITOR_WATCH_QUARTER_DAYS = 90;
function quarterStartDateStr() {
  const d = new Date();
  d.setDate(d.getDate() - COMPETITOR_WATCH_QUARTER_DAYS);
  return d.toISOString().slice(0, 10);
}

async function generateCompetitorWatchTrends(companyNames) {
  const list = companyNames && companyNames.length ? companyNames : COMPETITOR_WATCHLIST;
  if (list.length === 0) return [];

  const searchPerCompany = [];
  for (const name of list) {
    const query = buildCompetitorWatchQuery(name);
    try {
      // [v17] "최신 동향"이 핵심이므로 먼저 뉴스 카테고리 + 최근 1분기(90일)로 좁혀서 검색합니다.
      const quarterStart = quarterStartDateStr();
      let results = await callTavilySearch(query, 5, { topic: 'news', startDate: quarterStart });
      // [v16] 회사명이 실제로 등장하지 않는 결과(검색 엔진의 느슨한 매칭으로 섞여 들어온
      // 무관한 기사)는 AI에게 넘기기 전에 먼저 제거합니다.
  
      results = results.filter(r => resultMentionsCompany(r, name));
results = results.filter(r => !r.published_date || r.published_date >= quarterStart); 
results = results.filter(r => !containsObviouslyOldDate(r, quarterStart));      // 이 줄 추가
      // 5개사 모두가 매일 새 "뉴스"에 나오는 대기업은 아니라, 뉴스 검색이 비어 있으면
      // 일반 웹 검색으로 한 번 더 시도합니다(결과 없음으로 카드가 비는 것을 줄이기 위함).
      // [v17] 이 폴백도 더 이상 무제한 기간이 아니라 동일한 최근 1분기(90일)로 제한합니다.
 if (results.length === 0) {
  const general = await callTavilySearch(query, 5, { topic: 'general', startDate: quarterStart });
  results = general.filter(r => resultMentionsCompany(r, name));
  results = results.filter(r => !r.published_date || r.published_date >= quarterStart);
  // ↑ 이 줄 바로 다음에 아래 한 줄 추가
  results = results.filter(r => !containsObviouslyOldDate(r, quarterStart));
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

// ---------------------------------------------------------------------------
// [v22 — 2026-08-19] Joe 요청("해당 값에서 AI가 분석해서 플레이북에 있는 행동양식들이
// 나올 수 있도록 하는건 어떨까")에 대한 구현. Joe가 확인한 방식: "규칙 기반(추천) — 플레이북
// 원문 행동레버를 그대로 표로 박아넣고, 수치가 기준치보다 낮으면 해당 행동레버를 그대로
// 출력" — AI가 행동 추천 문장을 새로 만들지 않습니다(허위 행동레버가 나올 위험을 원천 차단).
// 아래 표는 `POUR_선행지표와행동레버_통합플레이북_리드용_20260818.html`(Joe 업로드본) 2번·4번
// 섹션 원문을 그대로 옮긴 것 — 절대 임의로 문구를 바꾸거나 새로 만들지 않습니다.
//
// 지금 파이프라인이 자동 계산하는 지표는 ④⑤⑥ 세 개뿐입니다(아래 buildLeadingIndicatorAlert
// 참고). ①90일 활성 협력사율·②첫 L2 도달은 "협약업체 마스터"(POUR협약업체리스트) 외부 파일과의
// 조인이 필요한데 아직 이 파이프라인에 연결되어 있지 않아(2026-08-18 세션에서 1회성 수동
// 계산만 했음) 이 비교에서는 제외합니다. ⑦은 미산출, ⑧은 층위가 달라(시장 결과, 영업 여정
// 병목이 아님) "가장 먼저 약해진 영업 여정 단계" 비교에는 포함하지 않고 별도로만 노출합니다.
// ---------------------------------------------------------------------------
const LEADING_INDICATOR_ACTIONS = [
  {
    key: 'active_partner_90d',
    label: '① 90일 활성 협력사율',
    layer: '영업여정',
    means_low: '협력사가 POUR 영업을 시작하지 않았거나, 시작은 했으나 L2가 기록되지 않음',
    action_lever: 'C/N/F 중 공종 적합·과거 활동이 있는 20개사에 첫 공종 선택, 영업 시작 묶음, 샘플·3분 설명자료·현장 등록 화면 중 하나를 시험',
    supporting_metric: '공종 선택률, 첫 자산 열람률, 현장등록 클릭률, 첫 L2 발생률',
    if_ineffective: '다운로드가 낮으면 자산 제목/형식, 다운로드는 높고 L2가 낮으면 현장등록 동선/대상군 적합성',
    pipeline_status: 'not_wired', // 협약업체 마스터 조인 미연결 — 자동 계산 불가(수동 계산만 존재)
  },
  {
    key: 'first_l2',
    label: '② 첫 L2 도달률/시간',
    layer: '영업여정',
    means_low: '온보딩이 영업 시작으로 이어지지 않음',
    action_lever: '공종 선택 UI, 영업 시작 자산, 첫 현장등록 동선, 초보 협력사 교육 중 하나를 개선',
    supporting_metric: '협약 후 7일 공종 선택, 14일 자산 열람, 30일 L2',
    if_ineffective: '공종 선택 자체가 낮으면 온보딩 메시지/화면, 선택은 높고 L2가 낮으면 영업자산 또는 현장등록 과정',
    pipeline_status: 'not_wired',
  },
  {
    key: 'l2_asset_use',
    label: '③ L2 맞춤자산 활용률',
    layer: '서비스실행',
    means_low: '자동 추천이 맞지 않거나, 자산 제목·형식·내용이 영업에 쓸모없음',
    action_lever: '사례/비교표/견적 해설/샘플 중 자산 하나를 바꾸고, 앱의 첫 노출 문구·버튼 위치를 테스트',
    supporting_metric: '노출→다운로드, 다운로드→재열람, "바로 사용 가능" VOC',
    if_ineffective: '노출이 낮으면 추천 로직/버튼 위치, 다운로드가 낮으면 자산의 제목/형식, VOC가 낮으면 내용',
    pipeline_status: 'not_wired', // 앱 로그 시트 위치 미확정
  },
  {
    key: 'l2_l3',
    label: '④ L2→L3 요청 전환율',
    layer: '영업여정',
    means_low: '현장은 있으나 고객 설득·가격·기술 신뢰를 만들 다음 지원으로 못 넘어감',
    action_lever: 'L2 시점에 맞춤 비교표, AI 실행견적, 샘플, PT 체크리스트, 현장검토 중 하나를 자동/선택형으로 제안',
    supporting_metric: '도움 선택률, 선택유형별 지원 수락률, 지원 후 14일 L3 요청',
    if_ineffective: '"아직 없음"이 많으면 더 많은 지원이 아니라 L2의 실질성·시점 점검. 특정 선택유형의 L3가 낮으면 그 수단 품질 수정',
    pipeline_status: 'wired', // categories_by_company_case로 자동 계산됨
  },
  {
    key: 'l3_l4',
    label: '⑤ L3→L4 공고 반영률',
    layer: '영업여정',
    means_low: '지원은 받았지만 아파트의 발주·공고 단계로 못 넘어감',
    action_lever: 'PT/공법설명, 공고 기술표현 검토, 유사 공고 사례, 현장신뢰 자료 중 하나를 선택',
    supporting_metric: 'PT 실행률, 기술표현 검토 완료, 고객 질문 해결, 유사 공고 사례 열람',
    if_ineffective: 'L3는 높고 L4가 낮으면 견적 속도보다 아파트 의사결정/발주조건 지원의 품질을 먼저 고침',
    pipeline_status: 'wired', // categories(현장 단위)로 자동 계산됨 — Joe 확인: L4는 업체 미확정 단계라 현장 단위가 정확
  },
  {
    key: 'reuse_60d',
    label: '⑥ 60일 재사용 L2율',
    layer: '영업여정',
    means_low: '첫 경험이 다음 영업에서 POUR 재사용으로 이어지지 않음',
    action_lever: '완료 공종과 연결된 다음 공종 사례, 견적 해설, 준공사진첩, PT 재사용 템플릿 중 하나를 제공',
    supporting_metric: '후속 자산 열람·재다운로드·다음 공종 버튼 클릭·VOC 필요유형',
    if_ineffective: '열람은 높고 재사용이 낮으면 다음 공종 연결이 틀림. 열람도 낮으면 완료사례의 형식·제목·전달시점 교체',
    pipeline_status: 'wired', // reuse_l2_60d로 자동 계산됨
  },
  {
    key: 'ai_doc_quality',
    label: '⑦ 문서형 지원 AI 품질',
    layer: '서비스실행',
    means_low: '지원 속도나 품질이 협력사의 영업 타이밍을 따라가지 못함',
    action_lever: 'AI가 접수 완결·초안·기한위험을 맡고, 팀은 단가 예외·복합공종·현장판단 같은 예외만 처리. 매주 상위 오류 하나를 템플릿에 반영',
    supporting_metric: '접수 완결률, AI 초안률, 1차 승인율, 사람 예외처리 비율, 재발행률',
    if_ineffective: '기한준수가 낮으면 어느 단계(입력/초안/예외)에서 멈췄는지 먼저 분해. "사람이 느리다"는 결론부터 내리지 않음',
    pipeline_status: 'not_wired', // 컨설팅요청/발행이력 탭 컬럼 미확인
  },
  {
    key: 'pour_vs_competitor',
    label: '⑧ POUR 대 타사 상대성장',
    layer: '시장결과',
    means_low: 'POUR가 타사보다 상대적으로 약해지는 공종·지역이 생김',
    action_lever: '상대성장이 낮은 공종·지역 2개만 골라 자산·준비 파트너·L2→L3 또는 L3→L4 병목 중 하나를 개선',
    supporting_metric: '해당 공종·지역의 활성협력사, L2, 다운로드, L3, PT/현장지원, POUR·타사 공고',
    if_ineffective: '타사 대비 POUR가 약한 공종은 L2부터, L2는 충분하면 L3·L4 병목부터 확인',
    pipeline_status: 'wired', // forecast_share로 자동 계산됨(단, 분모 기준 미표준화 — ⑧ 실측 결과 참고)
  },
];

// [v22] 플레이북 4번 섹션 "원칙"(층위 1번)을 그대로 구현: 활성 협력사 → L2 → L3 → L4 →
// 서비스실행 순서 중 "지금 파이프라인에서 자동 계산되는" 영업여정 지표(④⑤⑥)만 비교해
// 그중 값이 가장 낮은(=가장 먼저 약해진) 지표 하나를 고르고, 그 지표의 플레이북 원문
// 행동레버를 그대로 붙여 돌려줍니다. 값 자체는 위에서 이미 계산된 필드를 그대로 재사용하며
// 이 함수는 "무엇이 가장 낮은가"만 비교합니다 — AI 호출 없음, 새 수치도 만들지 않음.
function buildLeadingIndicatorAlert(categories, categoriesByCompanyCase, totalCompanyCases, reuseMetric) {
  if (!categories || !categoriesByCompanyCase || !totalCompanyCases) return null;

  const byKeySite = {};
  categories.forEach(c => { byKeySite[c.key] = c; });
  const byKeyCompany = {};
  categoriesByCompanyCase.forEach(c => { byKeyCompany[c.key] = c; });

  const l2OnlyCompany = byKeyCompany.l2_only ? byKeyCompany.l2_only.count : 0;
  const l2l3Rate = totalCompanyCases ? Number(((totalCompanyCases - l2OnlyCompany) / totalCompanyCases * 100).toFixed(1)) : null;

  const l3PlusSite = (byKeySite.l4_pending?.count || 0) + (byKeySite.lost_bid_failed?.count || 0) + (byKeySite.lost_to_competitor?.count || 0) + (byKeySite.won?.count || 0);
  const l3BaseSite = (byKeySite.l3_pending?.count || 0) + l3PlusSite;
  const l3l4Rate = l3BaseSite ? Number((l3PlusSite / l3BaseSite * 100).toFixed(1)) : null;

  // [v22] reuseMetric은 computeCustomerJourneyFunnel 내부의 buildReuseL2Metric() 결과를
  // 호출부에서 그대로 넘겨받습니다 — 이 함수는 nested function이라 여기서 직접 호출할 수
  // 없어 파라미터로 전달받는 구조로 뺐습니다(중복 계산도 방지).
  const reuse = reuseMetric || null;
  const reuseRate = reuse ? reuse.reuse_rate_pct : null;

  const candidates = [
    { key: 'l2_l3', value_pct: l2l3Rate, sample_note: `업체 단위 ${totalCompanyCases}건 중 L2 이후로 진행한 비율` },
    { key: 'l3_l4', value_pct: l3l4Rate, sample_note: `현장 단위 L3 이상 도달 ${l3BaseSite}건 중 L4 이상으로 이어진 비율` },
    { key: 'reuse_60d', value_pct: reuseRate, sample_note: reuse ? `L3+ 경험 업체 ${reuse.companies_with_l3plus_experience}개사 중 재사용 비율` : null },
  ].filter(c => c.value_pct !== null && c.value_pct !== undefined);

  if (!candidates.length) return null;

  const weakest = candidates.reduce((min, c) => (c.value_pct < min.value_pct ? c : min), candidates[0]);
  const def = LEADING_INDICATOR_ACTIONS.find(a => a.key === weakest.key);

  return {
    principle: '플레이북 1번 섹션 원칙: 활성 협력사 → L2 → L3 → L4 → 서비스실행 순서 중 가장 먼저 약해진 지표 1개에만 행동을 붙임',
    compared: candidates.map(c => ({ key: c.key, label: (LEADING_INDICATOR_ACTIONS.find(a => a.key === c.key) || {}).label, value_pct: c.value_pct, sample_note: c.sample_note })),
    not_compared_note: '①90일 활성 협력사율·②첫 L2 도달은 협약업체 마스터 데이터가 파이프라인에 아직 연결되지 않아 이 비교에 포함되지 않음(수동 계산치만 존재). ③⑦은 미산출. ⑧은 시장 결과 층위라 별도.',
    weakest: def ? {
      key: def.key,
      label: def.label,
      value_pct: weakest.value_pct,
      sample_note: weakest.sample_note,
      means_low: def.means_low,
      action_lever: def.action_lever,
      supporting_metric: def.supporting_metric,
      if_ineffective: def.if_ineffective,
    } : null,
  };
}

// [v16 추가 — 2026-08-18] Joe 요청("넷폼알앤디 부산 경남 지사, 포어솔루션은 데이터에서
// 제외하고 알려줘")에 따라, 이 두 업체가 관여한 케이스는 고객여정 퍼널 집계 전체(전체
// 케이스 수·단계별 비율·지역/공종별 세부 분류·업체별 분석 전부)에서 제외합니다 — "테스트"
// 더미 데이터 제외와 동일한 방식입니다. 정확한 사업적 사유는 안내받지 못했으며, 시트에
// 표기가 조금씩 달라질 수 있어(지사명 등) 접두어(시작 문자열) 일치로 판별합니다.
const JOURNEY_COMPANY_EXCLUDE_PREFIXES = ['넷폼알앤디', '포어솔루션'];
function isExcludedJourneyCompany(company) {
  return JOURNEY_COMPANY_EXCLUDE_PREFIXES.some(p => company.startsWith(p));
}

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

// ---------------------------------------------------------------------------
// [v15 추가 — 2026-08-18] Joe 요청("고객여정 데이터... 활동이 많아진 혹은 적어진, 그리고
// 특이점이 있는 업체 등 다양하게 볼 수 있도록") — "여정_최종" 시트의 '이벤트일자' 컬럼을
// 새로 활용해, 기존 케이스 집계(문의~낙찰 단계, 지역/공종별)와는 별도로 "업체(협력사)"
// 단위 분석을 추가합니다.
// ※ 위 주석(computeCustomerJourneyFunnel 내부)과 동일하게, 여기서 말하는 "업체명"은 실제
// 경쟁사가 아니라 우리 쪽 협력사(시공사)명입니다.
//   1) leaderboard         — 업체별 낙찰률·이탈률 순위표 (표본 JOURNEY_DIMENSION_MIN_SAMPLE건
//                            이상, by_region/by_worktype와 동일한 방식·기준)
//   2) activity_highlights — 최근/직전 JOURNEY_ACTIVITY_WINDOW_DAYS일 "이벤트(행) 건수"를
//                            비교해 업체별 활동 급증/급감·신규 진입을 감지 (규칙 기반, AI 아님)
//   3) dropout_anomalies   — 전체 평균 이탈률보다 JOURNEY_DROPOUT_ANOMALY_GAP%p 이상 높은
//                            업체 (표본 JOURNEY_DROPOUT_ANOMALY_MIN_SAMPLE건 이상)
//   4) stalled             — 공고(L4) 진행중 상태에서 마지막 이벤트가
//                            JOURNEY_STALE_L4_DAYS일 넘게 없는 케이스가 많은 업체
// 전부 이미 계산된 숫자를 규칙으로 걸러낸 것으로(AI 개입 없음), journey_funnel_commentary
// AI 코멘트에는 요약 신호로만 전달되고 원인은 추측하지 않습니다. "이벤트일자" 컬럼이 시트에
// 없으면(구조 변경 등) 이 분석 전체를 건너뛰고 나머지 집계(categories/by_region/by_worktype)
// 는 그대로 정상 동작합니다.
// ---------------------------------------------------------------------------
const JOURNEY_ACTIVITY_WINDOW_DAYS = 30;      // 활동 증가/감소 비교 기간(일)
const JOURNEY_ACTIVITY_MIN_BASE = 3;          // 직전 기간 값이 이보다 작으면 %변동 계산에서 제외
const JOURNEY_NEW_ENTRANT_MIN = 3;            // 신규 진입으로 표시할 최소 최근 건수
const JOURNEY_ACTIVITY_THRESH_PCT = 30;       // 최근/직전 대비 이 %이상 변동만 하이라이트
const JOURNEY_STALE_L4_DAYS = 45;             // 진행중(L4) 케이스가 이 일수 넘게 활동 없으면 "정체"
const JOURNEY_STALE_MIN_COUNT = 2;            // 정체 케이스가 이 건수 이상인 업체만 노출
const JOURNEY_DROPOUT_ANOMALY_MIN_SAMPLE = 10; // 이탈 집중 판정 최소 표본
const JOURNEY_DROPOUT_ANOMALY_GAP = 20;       // 전체 평균 대비 이탈률이 이 %p 이상 높으면 이상치
const JOURNEY_REUSE_WINDOW_DAYS = 60;         // [v21] ⑥ 재사용 L2 판정 기간(일) — 원본 플레이북 정의 그대로
const JOURNEY_COMPANY_LEADERBOARD_TOP_N = 10;
const JOURNEY_HIGHLIGHT_TOP_N = 8;

// "여정_최종" 시트의 '이벤트일자'는 "2026.5.5"처럼 점(.)으로 구분되고 0채움이 없는 경우가
// 있어, 점/하이픈/슬래시를 모두 허용하고 YYYY-MM-DD로 정규화합니다. 형식이 다르면 null.
// [2026-08-21 수정] Joe 피드백("고객여정상세에서 L2 날짜가 왜 미상이야, 등록일이 다 있는데")로
// 실제 시트를 확인한 결과, "2026. 5. 5"처럼 구분자 뒤에 공백이 들어간 행(주로 최근 L2 문의 건)이
// 있었고 기존 정규식은 공백을 허용하지 않아 파싱에 실패(null)하고 있었음 — company_analysis의
// as_of_date/activity_highlights/stalled 계산에서 해당 행들이 조용히 누락되는 문제였음. 구분자
// 뒤 공백을 허용하도록 수정(공백 없는 기존 형식도 계속 정상 동작).
function parseJourneyEventDate(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[.\-\/]\s*(\d{1,2})[.\-\/]\s*(\d{1,2})/);
  if (!m) return null;
  const mo = String(m[2]).padStart(2, '0'), d = String(m[3]).padStart(2, '0');
  const iso = `${m[1]}-${mo}-${d}`;
  return isNaN(new Date(iso).getTime()) ? null : iso;
}
function journeyDaysDiff(fromStr, toStr) {
  return Math.round((new Date(toStr) - new Date(fromStr)) / 86400000);
}

// [v15 수정 — 첫 실행 검증 중 발견] "이벤트일자"에 연도 오타로 보이는 미래 날짜(예: 2027년)가
// 섞여 있으면, "가장 최근 날짜"를 기준일(as_of_date)로 삼는 로직이 이 오타 값에 끌려가
// 최근/직전 30일 비교 창 전체가 실제 데이터 범위 밖으로 밀려나 버립니다(활동 하이라이트·정체
// 감지가 전부 비어버리는 원인이 됨). 그래서 이 스크립트가 실제로 실행되는 시점(GitHub Actions
// 서버의 실제 오늘 날짜)보다 미래인 이벤트일자, 그리고 지나치게 오래된(2015년 이전) 값은
// "판별 불가"로 취급해 날짜 기반 계산(활동 추이·정체 판정)에서만 제외합니다 — 케이스 분류
// (문의~낙찰 단계, 순위표의 낙찰률·이탈률)에는 영향이 없습니다.
const JOURNEY_TODAY = new Date().toISOString().slice(0, 10);
const JOURNEY_MIN_VALID_DATE = '2015-01-01';
function isPlausibleJourneyEventDate(dateStr) {
  if (!dateStr) return false;
  return dateStr >= JOURNEY_MIN_VALID_DATE && dateStr <= addDays(JOURNEY_TODAY, 1);
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

  // [v18 추가 — 2026-08-18] Joe 요청("여정_최종 아파트 ID 수정했습니다. 확인해서 반영할 곳
  // 있으면 반영해주세요") — Joe가 "아파트ID"를 원본 6개 탭에 각자 남아있던 값이 아니라
  // 공식 API(주소 기반 단지 조회)로 재정리했다고 확인해줬습니다. 실제로 재확인한 결과 같은
  // 현장(예: 동산휴먼시아 L2→L3 진행 건)의 아파트ID가 이제 일관되게 일치함을 확인했고,
  // Joe가 "아파트ID 우선, 텍스트는 보조"를 선택해 케이스 매칭 기준을 전환합니다. 기존
  // "아파트명+주소" 방식은 주소 표기 차이(예: "인천광역시 동구 인천 동구 ~" vs "인천 동구
  // ~")만으로 같은 현장이 서로 다른 케이스로 갈리는 문제가 있었는데, 이제 아파트ID가 있는
  // 행은 그 문제에서 자유롭습니다. 다만 아파트ID가 비어있는 행은 계속 기존 텍스트 방식으로
  // 폴백합니다. v12에서 아파트ID를 피했던 이유(구글시트 숫자 정밀도 손실로 서로 다른
  // 단지가 같은 ID로 겹치던 문제)는 API로 재조회한 값이라 더 이상 해당하지 않을 것으로
  // 보이나, 만일을 위해 같은 아파트ID가 서로 다른 아파트명과 매칭되는 경우를 계속
  // 자동으로 탐지해 로그로 남깁니다(아래 aptIdNames).
  const iAptId = idx('아파트ID');

  const priorityMap = {};
  JOURNEY_CATEGORIES.forEach(c => { priorityMap[c.key] = c.priority; });

  // [v15] '이벤트일자' 컬럼은 업체별 분석에만 쓰이므로 없어도 나머지 집계는 그대로 동작하게
  // 필수 컬럼 목록(iAptName 등)에는 포함하지 않고 별도로 확인합니다.
  const iEventDate = idx('이벤트일자');

  const best = new Map(); // case_key(v18: 아파트ID 우선, 없으면 아파트명+주소, +공종명) -> { key, priority, region, worktype }
  const companyCase = new Map(); // case_key+업체명 -> { key, priority, company, lastDate } — [v15] 업체별 분석용
  const companyEvents = []; // { company, date } — [v15] 업체별 활동(이벤트) 추이용
  // [v21 — 2026-08-19] ⑥ 60일 재사용 L2율 계산용. 업체 -> (현장키(아파트명+주소+공종명, 업체명
  // 제외) -> {firstL2, firstL3Plus}). Joe 확인: "업체명+현장명+공종명이 일치해야 연결되는거
  // 아니냐"(v20) 정의를 그대로 재사용 — 이 지표는 "같은 업체가 다른 현장에서 재사용했는지"를
  // 보는 것이라, 현장키는 업체명을 뺀 키(아파트명+주소+공종명)여야 "다른 현장"을 구분할 수
  // 있고, 그 현장키들을 업체별로 묶어야 "같은 업체의 여러 현장"을 비교할 수 있습니다.
  const companySiteFirstDates = new Map();
  const aptIdNames = new Map(); // [v18] 아파트ID -> Set(아파트명) — 품질 모니터링용(같은 ID가 다른 이름과 매칭되는지)
  let testExcluded = 0;
  let companyExcluded = 0; // [v16] Joe 요청으로 제외한 업체(JOURNEY_COMPANY_EXCLUDE_PREFIXES) 행 수
  let skippedNoCategory = 0;
  let implausibleDateExcluded = 0; // [v15] 미래/지나치게 과거인 이벤트일자(오타 추정) 건수

  journeyRows.slice(1).forEach(r => {
    if (!r || r.length < 2) return;
    const company = (r[iCompany] || '').trim();
    if (company.includes('테스트')) { testExcluded++; return; }
    if (isExcludedJourneyCompany(company)) { companyExcluded++; return; }
    const aptName = (r[iAptName] || '').trim();
    const addr = (r[iAddr] || '').trim();
    const work = (r[iWork] || '').trim();
    if (!aptName || !addr) return;
    const aptId = iAptId >= 0 ? (r[iAptId] || '').trim() : '';

    if (aptId) {
      if (!aptIdNames.has(aptId)) aptIdNames.set(aptId, new Set());
      aptIdNames.get(aptId).add(aptName);
    }

    const stage = (r[iStage] || '').trim();
    const status = (r[iStatus] || '').trim();
    const catKey = classifyJourneyRow(stage, status);
    const eventDateRaw = iEventDate >= 0 ? parseJourneyEventDate(r[iEventDate]) : null;
    const eventDate = isPlausibleJourneyEventDate(eventDateRaw) ? eventDateRaw : null;
    if (eventDateRaw && !eventDate) implausibleDateExcluded++;
    if (company && eventDate) companyEvents.push({ company, date: eventDate });

    if (!catKey) { skippedNoCategory++; return; }

    // [v19 — 2026-08-18] Joe 확인("제안한걸로 해주세요") — v18에서 켠 "아파트ID 우선"
    // 매칭을 일단 되돌립니다. 배포 직후 아래 apartment_id_quality 진단에서 고유 ID 897개 중
    // 178개(약 20%)가 서로 다른 아파트명과 겹치는 게 확인됐고, 라이브 시트 재확인 결과 같은
    // 단지(대주파크빌아파트, 인천 서구 마전로99번길 8)인데도 등록 건마다 아파트ID가
    // 3개(2635010500114080000000001 / 4719012200105780000002527 /
    // 4146510500102160000200003)로 다르게 붙어 있음을 발견했습니다 — "API로 정리했다"는
    // 아파트ID가 아직 단지 단위로 일관되지 않은 상태로 보여, 원인이 확인될 때까지 케이스
    // 매칭은 기존 "아파트명+주소" 텍스트 방식으로만 사용합니다. 아래 아파트ID 품질 모니터링
    // (aptIdNames/aptIdCollisions)은 그대로 남겨둬 원인이 해소되는지 계속 추적합니다 —
    // colliding_apt_ids가 0에 가까워지면 그때 다시 ID 우선으로 전환을 검토합니다.
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

    // [v15] 케이스+업체 단위로도 별도 집계 — 같은 현장·공종에 여러 협력사가 관여할 수 있어
    // (케이스 단위 best와 달리) 업체별 성과/정체 판단에는 업체를 키에 포함해야 합니다.
    if (company) {
      const groupKey = `${caseKey}__${company}`;
      let entry = companyCase.get(groupKey);
      if (!entry) {
        entry = { key: catKey, priority: p, company, lastDate: eventDate || null };
        companyCase.set(groupKey, entry);
      } else {
        if (p >= entry.priority) { entry.key = catKey; entry.priority = p; }
        if (eventDate && (!entry.lastDate || eventDate > entry.lastDate)) entry.lastDate = eventDate;
      }
    }

    // [v21] ⑥ 60일 재사용 L2율 재료 — 업체별로 현장(caseKey)마다 "처음 L2 찍힌 날"과
    // "처음 L3 이상 찍힌 날"을 기록. 원문 단계값(stage)을 그대로 씁니다(catKey는 유찰/낙찰
    // 등으로 재분류될 수 있어서, "실제 시트에 L3/L4/L5로 찍힌 적이 있는가"를 보려면 원문이
    // 더 정확함). eventDate가 없는 행은 날짜 비교가 불가능하므로 건너뜁니다.
    if (company && eventDate) {
      if (!companySiteFirstDates.has(company)) companySiteFirstDates.set(company, new Map());
      const siteMap = companySiteFirstDates.get(company);
      if (!siteMap.has(caseKey)) siteMap.set(caseKey, { firstL2: null, firstL3Plus: null });
      const site = siteMap.get(caseKey);
      if (stage === 'L2') {
        if (!site.firstL2 || eventDate < site.firstL2) site.firstL2 = eventDate;
      } else if (stage === 'L3' || stage === 'L4' || stage === 'L5') {
        if (!site.firstL3Plus || eventDate < site.firstL3Plus) site.firstL3Plus = eventDate;
      }
    }
  });

  // [v18] 아파트ID 품질 모니터링 — 같은 아파트ID가 서로 다른 아파트명과 매칭되는 경우가
  // 있는지 자동 탐지합니다(v12에서 우려했던 "다른 단지가 같은 ID로 겹치는" 문제가 API
  // 재정리 이후에도 남아있는지 매 실행마다 확인). 발견되면 케이스 집계를 막지는 않고
  // (아파트ID 우선 방식은 그대로 유지) 로그로만 남겨 Joe가 원본 확인할 수 있게 합니다.
  let aptIdCollisions = 0;
  const aptIdCollisionExamples = [];
  aptIdNames.forEach((names, id) => {
    if (names.size > 1) {
      aptIdCollisions++;
      if (aptIdCollisionExamples.length < 10) {
        aptIdCollisionExamples.push({ apt_id: id, names: Array.from(names) });
      }
    }
  });
  if (aptIdCollisions > 0) {
    console.warn(`  - ⚠ 아파트ID 품질 확인 필요: ${aptIdCollisions}개 ID가 서로 다른 아파트명과 매칭됨(표본: ${JSON.stringify(aptIdCollisionExamples.slice(0, 3))})`);
  }

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

  // [v20 — 2026-08-19] Joe 확인("업체명,현장명과 공종명이 일치해야 연결시킬 수 있는거
  // 아니냐") — 맞는 지적입니다. 위 `categories`/`total_cases`는 케이스 키가
  // 아파트명+주소+공종명뿐이라 업체명이 빠져 있고, 같은 현장·같은 공종에 여러 협력사가
  // 관여하면 그중 가장 진행된 업체 하나로 뭉개집니다. `companyCase`(업체명까지 포함한 키,
  // [v15]부터 이미 계산되고 있었으나 지금까지는 company_analysis 내부 집계에만 쓰이고
  // categories처럼 전체 분포로는 출력된 적이 없었음)를 그대로 categories와 동일한 구조로
  // 전체 집계해 출력합니다. 이게 "업체명+현장명+공종명"이 모두 일치해야 하나로 묶이는,
  // 실제 협력사별 딜(lead) 단위 기준입니다. ④(L2→L3)·⑤(L3→L4) 등 업체 단위 선행지표는
  // 이제 categories가 아니라 이 categories_by_company_case를 근거로 계산해야 합니다.
  const companyCaseCounts = {};
  JOURNEY_CATEGORIES.forEach(c => { companyCaseCounts[c.key] = 0; });
  companyCase.forEach(v => { companyCaseCounts[v.key] = (companyCaseCounts[v.key] || 0) + 1; });
  const totalCompanyCases = companyCase.size;
  const categoriesByCompanyCase = JOURNEY_CATEGORIES.map(c => ({
    key: c.key,
    label: c.label,
    count: companyCaseCounts[c.key] || 0,
    pct: totalCompanyCases ? Number(((companyCaseCounts[c.key] || 0) / totalCompanyCases * 100).toFixed(1)) : 0,
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

  // [v15] 업체(협력사)별 분석 — '이벤트일자' 컬럼이 있을 때만 계산합니다.
  function buildCompanyAnalysis() {
    if (iEventDate < 0 || companyCase.size === 0) return null;

    const companyBuckets = new Map(); // company -> {total, dropout, won, lostToCompetitor, l4Pending, staleL4}
    let asOfDate = null;
    companyEvents.forEach(e => { if (!asOfDate || e.date > asOfDate) asOfDate = e.date; });
    if (!asOfDate) return null; // 유효한 날짜가 하나도 없으면 계산 불가

    companyCase.forEach(v => {
      if (!companyBuckets.has(v.company)) companyBuckets.set(v.company, { total: 0, dropout: 0, won: 0, lostToCompetitor: 0, l4Pending: 0, staleL4: 0 });
      const b = companyBuckets.get(v.company);
      b.total++;
      if (JOURNEY_DROPOUT_KEYS.has(v.key)) b.dropout++;
      if (v.key === 'won') b.won++;
      if (v.key === 'lost_to_competitor') b.lostToCompetitor++;
      if (v.key === 'l4_pending') {
        b.l4Pending++;
        if (v.lastDate && journeyDaysDiff(v.lastDate, asOfDate) >= JOURNEY_STALE_L4_DAYS) b.staleL4++;
      }
    });

    let dropoutTotalAll = 0, dropoutSumAll = 0;
    companyBuckets.forEach(b => { dropoutTotalAll += b.total; dropoutSumAll += b.dropout; });
    const overallDropoutPct = dropoutTotalAll ? Number((dropoutSumAll / dropoutTotalAll * 100).toFixed(1)) : 0;

    // 1) 업체별 낙찰률·이탈률 순위표 — by_region/by_worktype와 동일한 표본 기준
    const leaderboard = Array.from(companyBuckets.entries())
      .map(([company, b]) => ({
        company, total: b.total,
        dropout: b.dropout, dropout_pct: b.total ? Number((b.dropout / b.total * 100).toFixed(1)) : 0,
        won: b.won, won_pct: b.total ? Number((b.won / b.total * 100).toFixed(1)) : 0,
        lost_to_competitor: b.lostToCompetitor,
        l4_pending: b.l4Pending, stale_l4: b.staleL4,
      }))
      .filter(x => x.total >= JOURNEY_DIMENSION_MIN_SAMPLE)
      .sort((a, b) => b.total - a.total)
      .slice(0, JOURNEY_COMPANY_LEADERBOARD_TOP_N);

    // 2) 오래 정체된 진행중(L4) 케이스가 많은 업체
    const stalled = Array.from(companyBuckets.entries())
      .map(([company, b]) => ({ company, stale_l4: b.staleL4, l4_pending: b.l4Pending }))
      .filter(x => x.stale_l4 >= JOURNEY_STALE_MIN_COUNT)
      .sort((a, b) => b.stale_l4 - a.stale_l4)
      .slice(0, JOURNEY_COMPANY_LEADERBOARD_TOP_N);

    // 3) 전체 평균보다 이탈률이 유난히 높은 업체(이탈 집중)
    const dropoutAnomalies = Array.from(companyBuckets.entries())
      .map(([company, b]) => ({ company, total: b.total, dropout: b.dropout, dropout_pct: b.total ? Number((b.dropout / b.total * 100).toFixed(1)) : 0 }))
      .filter(x => x.total >= JOURNEY_DROPOUT_ANOMALY_MIN_SAMPLE && (x.dropout_pct - overallDropoutPct) >= JOURNEY_DROPOUT_ANOMALY_GAP)
      .sort((a, b) => b.dropout_pct - a.dropout_pct)
      .slice(0, JOURNEY_COMPANY_LEADERBOARD_TOP_N);

    // 4) 최근/직전 JOURNEY_ACTIVITY_WINDOW_DAYS일 "이벤트(행) 건수" 비교 — 활동 급증/급감·신규 진입
    const recentFrom = addDays(asOfDate, -(JOURNEY_ACTIVITY_WINDOW_DAYS - 1));
    const prevTo = addDays(recentFrom, -1);
    const prevFrom = addDays(prevTo, -(JOURNEY_ACTIVITY_WINDOW_DAYS - 1));

    const companyEventCounts = new Map(); // company -> {recent, prev}
    companyEvents.forEach(({ company, date }) => {
      if (!companyEventCounts.has(company)) companyEventCounts.set(company, { recent: 0, prev: 0 });
      const c = companyEventCounts.get(company);
      if (date >= recentFrom && date <= asOfDate) c.recent++;
      else if (date >= prevFrom && date <= prevTo) c.prev++;
    });

    const activityHighlights = [];
    companyEventCounts.forEach((c, company) => {
      if (c.prev === 0) {
        if (c.recent >= JOURNEY_NEW_ENTRANT_MIN) {
          activityHighlights.push({
            company, direction: 'new', recent: c.recent, prev: c.prev, score: 50 + c.recent,
            text: `<b>${company}</b> 관련 활동이 최근 ${JOURNEY_ACTIVITY_WINDOW_DAYS}일간 새로 ${c.recent}건 발생했습니다 (직전 ${JOURNEY_ACTIVITY_WINDOW_DAYS}일 0건).`,
          });
        }
        return;
      }
      if (c.prev < JOURNEY_ACTIVITY_MIN_BASE) return;
      const pct = (c.recent - c.prev) / c.prev * 100;
      if (Math.abs(pct) >= JOURNEY_ACTIVITY_THRESH_PCT) {
        activityHighlights.push({
          company, direction: pct > 0 ? 'up' : 'down', recent: c.recent, prev: c.prev, pct: Number(pct.toFixed(0)), score: Math.abs(pct),
          text: `<b>${company}</b> 관련 활동이 직전 ${JOURNEY_ACTIVITY_WINDOW_DAYS}일 ${c.prev}건 → 최근 ${JOURNEY_ACTIVITY_WINDOW_DAYS}일 ${c.recent}건으로 ${pct > 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(0)}% ${pct > 0 ? '증가' : '감소'}했습니다.`,
        });
      }
    });
    activityHighlights.sort((a, b) => b.score - a.score);

    return {
      as_of_date: asOfDate,
      window_days: JOURNEY_ACTIVITY_WINDOW_DAYS,
      min_sample: JOURNEY_DIMENSION_MIN_SAMPLE,
      overall_dropout_pct: overallDropoutPct,
      leaderboard,
      activity_highlights: activityHighlights.slice(0, JOURNEY_HIGHLIGHT_TOP_N),
      dropout_anomalies: dropoutAnomalies,
      stalled,
      stale_l4_days: JOURNEY_STALE_L4_DAYS,
      dropout_anomaly_min_sample: JOURNEY_DROPOUT_ANOMALY_MIN_SAMPLE,
      dropout_anomaly_gap: JOURNEY_DROPOUT_ANOMALY_GAP,
      implausible_dates_excluded: implausibleDateExcluded,
    };
  }

  // [v21 — 2026-08-19] ⑥ 60일 재사용 L2율. 정의(원본 플레이북 2번 섹션): "L3/L4 경험 후
  // 60일 내 다른 현장 L2를 등록한 협력사 ÷ L3/L4 경험 협력사". Joe 확인된 케이스 정의(업체명+
  // 현장명+공종명)를 그대로 적용 — 위 companySiteFirstDates(업체 -> 현장키 -> {firstL2,
  // firstL3Plus})를 사용합니다.
  // 한계: (1) "L3/L4 경험"의 기준일로 그 현장에서 실제로 처음 L3/L4/L5 단계가 찍힌 날짜
  // (firstL3Plus)를 씀 — 원문 플레이북은 "L3/L4 경험 후"라고만 하고 L3 시점인지 L4 시점인지
  // 명시하지 않아, 더 이른 시점인 "L3 이상 처음 도달"을 기준으로 함(더 관대한 기준).
  // (2) '이벤트일자'가 없는 행은 날짜 비교가 불가능해 제외됨(implausible_dates_excluded와
  // 별개로 집계, 아래 dates_missing_excluded 참고).
  function buildReuseL2Metric() {
    if (iEventDate < 0 || companySiteFirstDates.size === 0) return null;
    let companiesWithL3Plus = 0;
    let reusedCount = 0;
    const reusedCompanySample = [];
    companySiteFirstDates.forEach((siteMap, company) => {
      const l3PlusSites = [];
      siteMap.forEach((v, siteKey) => { if (v.firstL3Plus) l3PlusSites.push({ siteKey, date: v.firstL3Plus }); });
      if (l3PlusSites.length === 0) return;
      companiesWithL3Plus++;
      let reused = false;
      for (const ref of l3PlusSites) {
        siteMap.forEach((v, siteKey) => {
          if (reused || siteKey === ref.siteKey || !v.firstL2) return;
          const diff = journeyDaysDiff(ref.date, v.firstL2); // ref.date(L3+ 도달) -> firstL2(다른 현장)까지 일수
          if (diff >= 0 && diff <= JOURNEY_REUSE_WINDOW_DAYS) reused = true;
        });
        if (reused) break;
      }
      if (reused) {
        reusedCount++;
        if (reusedCompanySample.length < 20) reusedCompanySample.push(company);
      }
    });
    return {
      window_days: JOURNEY_REUSE_WINDOW_DAYS,
      case_key_method: 'apt_name__addr__worktype (업체명 제외 — 같은 업체 내 "다른 현장"을 구분하는 키)',
      companies_with_l3plus_experience: companiesWithL3Plus,
      reused_within_window: reusedCount,
      reuse_rate_pct: companiesWithL3Plus ? Number((reusedCount / companiesWithL3Plus * 100).toFixed(1)) : 0,
      reused_company_sample: reusedCompanySample,
      caveat: 'L3/L4 경험 기준일은 해당 현장에서 L3 이상이 처음 찍힌 날짜(firstL3Plus, 더 관대한 기준). 이벤트일자 없는 행은 날짜 비교 불가로 제외됨.',
    };
  }

  // [v22] buildReuseL2Metric()을 한 번만 계산해 reuse_l2_60d와 leading_indicator_alert
  // 양쪽에서 재사용합니다(중복 계산 방지).
  const reuseMetricResult = buildReuseL2Metric();

  return {
    total_cases: totalCases,
    total_source_rows: journeyRows.length - 1,
    excluded_test_rows: testExcluded,
    excluded_company_rows: companyExcluded,
    excluded_company_names: JOURNEY_COMPANY_EXCLUDE_PREFIXES,
    skipped_rows_no_category: skippedNoCategory,
    categories,
    // [v20] 업체명+아파트명+주소+공종명 모두 일치하는 키 기준 전체 분포(위 "categoriesByCompanyCase"
    // 계산부 주석 참고) — categories와 total_cases는 업체명이 빠진 "현장·공종" 단위라 여러
    // 협력사가 얽힌 케이스를 과대평가할 수 있음. 업체 단위 선행지표(④⑤ 등)는 이쪽을 사용할 것.
    total_company_cases: totalCompanyCases,
    company_case_key_method: 'apt_name__addr__worktype__company_name',
    categories_by_company_case: categoriesByCompanyCase,
    by_region: buildDimensionBreakdown('region'),
    by_worktype: buildDimensionBreakdown('worktype'),
    dimension_min_sample: JOURNEY_DIMENSION_MIN_SAMPLE,
    company_analysis: buildCompanyAnalysis(),
    // [v21] ⑥ 60일 재사용 L2율 — 위 buildReuseL2Metric() 계산부 주석 참고.
    reuse_l2_60d: reuseMetricResult,
    // [v22] Joe 요청("행동양식들이 나올 수 있도록") — 플레이북 원문 행동레버 표(위
    // LEADING_INDICATOR_ACTIONS)에서 지금 자동 계산되는 영업여정 지표(④⑤⑥) 중 가장 낮은
    // 값을 찾아 그 지표의 원문 행동레버를 그대로 붙여 반환. AI 생성 없음(규칙 기반).
    leading_indicator_alert: buildLeadingIndicatorAlert(categories, categoriesByCompanyCase, totalCompanyCases, reuseMetricResult),
    // [v19] 아파트ID 매칭 품질 모니터링(참고용, 케이스 매칭에는 미사용) — v18에서 켰던
    // "아파트ID 우선" 매칭은 아래 진단(같은 ID가 다른 단지와 겹치는 문제)이 확인되어 v19에서
    // 되돌렸습니다. case_key_method는 지금 실제로 쓰이는 매칭 기준이 텍스트 방식임을
    // 나타내며, colliding_apt_ids가 원인 확인 후 0에 가까워지면 ID 우선 전환을 재검토합니다.
    apartment_id_quality: {
      case_key_method: 'text_based_v19_pending_apt_id_fix',
      apt_id_column_found: iAptId >= 0,
      distinct_apt_ids: aptIdNames.size,
      colliding_apt_ids: aptIdCollisions,
      collision_examples: aptIdCollisionExamples,
    },
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

  // [v15 추가] 업체(협력사)별 분석 신호 — activity_highlights/dropout_anomalies/stalled 중
  // 상위 몇 건만 문장으로 요약해 AI 코멘트 입력에 포함합니다(전부 넣으면 프롬프트가 너무
  // 길어지므로 각 유형별 상위 2~3건만). ※ '업체명'은 실제 경쟁사가 아니라 우리 협력사명.
  const ca = jf.company_analysis;
  if (ca) {
    if (ca.activity_highlights && ca.activity_highlights.length) {
      const top = ca.activity_highlights.slice(0, 3).map(h => h.text.replace(/<\/?b>/g, ''));
      lines.push(`협력사별 활동 변동(기준일 ${ca.as_of_date}, 최근/직전 ${ca.window_days}일 비교): ${top.join(' ')}`);
    }
    if (ca.dropout_anomalies && ca.dropout_anomalies.length) {
      const top = ca.dropout_anomalies.slice(0, 2).map(a => `${a.company}(${a.total}건 중 ${a.dropout}건, ${a.dropout_pct}%)`);
      lines.push(`전체 평균 이탈률(${ca.overall_dropout_pct}%)보다 유난히 높은 협력사: ${top.join(', ')}.`);
    }
    if (ca.stalled && ca.stalled.length) {
      const top = ca.stalled.slice(0, 2).map(s => `${s.company}(진행중 ${s.l4_pending}건 중 ${s.stale_l4}건이 ${ca.stale_l4_days}일 넘게 업데이트 없음)`);
      lines.push(`공고(L4) 진행중 상태로 오래 정체된 협력사: ${top.join(', ')}.`);
    }
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
- "협력사"(업체) 관련 신호가 있다면 함께 짚어주세요. 단, 여기서 '업체명'은 우리 쪽 시공 협력사이지 낙찰받은 경쟁사가 아니므로, 협력사에 대해 언급할 때는 "영업/현장 관리 차원에서 확인해볼 만하다"는 취지로만 표현하고, 그 협력사의 잘잘못을 단정하지 마세요.
- 과장하지 말고 사실 위주로, 실무진이 바로 읽을 수 있도록 문장 단위로 끊어 한국어로 3~6문장 이내로 작성하세요.
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
 console.log('[5/9] 주요 경쟁사 5개사 + 신흥 업체 최신 동향(뉴스) 생성 중...');
const emergingNames = ctx.highlights
  .filter(h => h.type === 'emerging')
  .map(h => h.subject)
  .filter((name, i, arr) => name && arr.indexOf(name) === i);
if (emergingNames.length) console.log(`  - 신흥 업체 감지: ${emergingNames.join(', ')}`);
const competitorWatchList = [...COMPETITOR_WATCHLIST, ...emergingNames];
const competitorWatch = await generateCompetitorWatchTrends(competitorWatchList);
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
      ? `  - 케이스 ${journeyFunnel.total_cases}건 집계됨(원본 ${journeyFunnel.total_source_rows}행, 테스트데이터 ${journeyFunnel.excluded_test_rows}행·제외 업체(${journeyFunnel.excluded_company_names.join(', ')}) ${journeyFunnel.excluded_company_rows}행 제외)`
      : '  - 집계 실패(시트 구조 확인 필요) — 건너뜀');
    // [v15] 업체(협력사)별 분석 — '이벤트일자' 컬럼이 없거나 계산 불가하면 null(건너뜀).
    if (journeyFunnel && journeyFunnel.company_analysis) {
      const ca = journeyFunnel.company_analysis;
      console.log(`  - 업체별 분석: 순위표 ${ca.leaderboard.length}개사, 활동 하이라이트 ${ca.activity_highlights.length}건, 이탈 집중 ${ca.dropout_anomalies.length}개사, 정체 ${ca.stalled.length}개사 (기준일 ${ca.as_of_date})`);
      if (ca.implausible_dates_excluded > 0) {
        console.log(`  - ⚠ "이벤트일자"가 오늘(${JOURNEY_TODAY})보다 미래이거나 지나치게 과거(2015년 이전)인 값 ${ca.implausible_dates_excluded}건은 날짜 기반 계산(활동 추이·정체 판정)에서 제외했습니다(입력 오타 추정, 원본 시트 확인 권장).`);
      }
    } else if (journeyFunnel) {
      console.log('  - 업체별 분석: 건너뜀("이벤트일자" 컬럼 없음 또는 유효 날짜 없음)');
    }
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

  // [v14 추가] 예상 결과(간단 추정) — Joe 요청("혹시 예상 되는 결과 도출도 가능하니")
  console.log('[예상치] 이번 달/올해 남은 기간 예상 공고 건수, 업체·공종별 예상 점유율, 고객여정 예상 낙찰 계산 중...');
  const monthlyForecast = computeMonthlyForecast(ds, ref2025);
  const shareForecast = computeShareForecast(ds, ref2025);
  const journeyWinForecast = computeJourneyWinForecast(journeyFunnel);
  const forecastLines = buildForecastHighlightLines(monthlyForecast, shareForecast, journeyWinForecast);
  let forecastResult = { commentary: null, model: null };
  if (forecastLines.length) {
    if (monthlyForecast && monthlyForecast.thisMonthForecast) console.log(`  - 이번 달(${monthlyForecast.latestYm}) 예상 ${monthlyForecast.thisMonthForecast.total}건(${monthlyForecast.thisMonthMethod})`);
    if (shareForecast.hasEnoughData) console.log(`  - 점유율 변화 신호 ${shareForecast.rows.length}건`);
    if (journeyWinForecast && journeyWinForecast.hasEnoughData) console.log(`  - 고객여정 예상 추가 낙찰 ${journeyWinForecast.expected_additional_wins}건(진행중 ${journeyWinForecast.l4Pending}건 기준)`);
    forecastResult = await callClaudeForForecast(forecastLines);
    console.log(`  - 예상 항목 ${forecastLines.length}건, 코멘트 ${forecastResult.commentary ? '생성됨' : '생성 안 됨'}`);
  } else {
    console.log('  - 계산된 예상치가 없어(데이터 부족) 건너뜀');
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

    // --- [v8, v9에서 강화, v17에서 기간 조정] 주요 경쟁사 5개사(4A시스템·금영ENC·피엠씨·
    //     미래피앤씨·수퍼크랙실)의 최신 동향(뉴스) — 그날의 하이라이트 상위 3건 여부와 무관하게
    //     매일 5개사 전원 대상, Tavily topic=news + 최근 1분기(90일) 필터로 실제 최신 뉴스
    //     위주 검색 (실패/미검색 시 빈 배열). 폴백(topic=general)도 동일하게 최근 1분기로 제한.
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

    // --- [v14 추가] 예상 결과(간단 추정) — Joe 요청("혹시 예상 되는 결과 도출도 가능하니").
    //     (1) forecast_monthly: 이번 달/올해 남은 기간 예상 공고 건수
    //     (2) forecast_share: 업체별·공종별·구분별 예상 점유율 변화(연말 예상치, 선형 추세 가정)
    //     (3) forecast_journey_win: 고객여정 퍼널 예상 낙찰 건수
    //     ⚠ 모두 과거 패턴을 그대로 연장한 단순 추정이며 통계적 예측 모델이 아닙니다.
    //     2025년 참고 데이터(data/reference-2025-daily.json)가 없으면 forecast_monthly의
    //     남은 달 예상·forecast_share는 비어있을 수 있습니다.
    forecast_monthly: monthlyForecast,
    forecast_share: shareForecast,
    forecast_journey_win: journeyWinForecast,
    forecast_model: forecastResult.model,
    forecast_commentary: forecastResult.commentary,
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
  COMPETITOR_WATCHLIST, buildCompetitorWatchQuery, generateCompetitorWatchTrends, resultMentionsCompany,
  JOURNEY_CATEGORIES, classifyJourneyRow, computeCustomerJourneyFunnel,
  normalizeJourneyRegion, primaryJourneyWorktype, buildJourneyFunnelHighlightLines,
  callClaudeForJourneyFunnel, parseJourneyEventDate, journeyDaysDiff,
  loadReference2025, computeYoySignals,
  sumFieldsForYtd, computeMonthlyForecast, computeShareForecastGroup, computeShareForecast,
  computeJourneyWinForecast, buildForecastHighlightLines, callClaudeForForecast,
};
