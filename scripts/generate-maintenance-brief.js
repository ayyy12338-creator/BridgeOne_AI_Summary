#!/usr/bin/env node
/**
 * 브릿지원 데이터매니저 — CERIK "유지보수 시장 동향" 주간 브리핑 생성 스크립트
 * ------------------------------------------------------------------------
 * 한국건설산업연구원(CERIK) 동향브리핑(https://cerik.re.kr/report/briefing)은 매주 1회
 * (금요일경) 새 호가 올라오는 건설산업 전반 동향 리포트입니다. 이 스크립트는 매주:
 *   1) 목록 페이지에서 가장 최신 호의 상세 페이지 링크를 찾고
 *   2) 그 상세 페이지 내용을 가져와 텍스트로 정리한 뒤
 *   3) AI(Gemini/Claude)에게 "유지보수 시장(재도장·방수·하자보수·리모델링·유지관리 등)과
 *      관련된 내용이 있는지, 있다면 긍정/부정/중립 신호와 요약을 JSON으로" 요청하고
 *   4) 결과를 data/latest-maintenance-brief.json 으로 저장(커밋)합니다.
 *
 * scripts/generate-insight.js와 마찬가지로 "AI가 원문에 없는 내용을 창작하지 않도록"
 * 프롬프트에 명시하고, 원문 링크를 항상 함께 저장해 실무자가 직접 확인할 수 있게 합니다.
 *
 * ⚠ 중요(최초 배포 시 참고): 이 스크립트는 CERIK 웹사이트의 실제 HTML 구조를 이 개발
 * 환경에서 직접 열람해 확인하지 못한 상태로 작성되었습니다(사내 네트워크 정책상 해당
 * 도메인 접속이 막혀 있었음). 목록/상세 페이지의 링크 패턴은 별도 조사로 확인한
 * "/report/briefing/{숫자ID}" 형태를 기준으로 만들었지만, 실제 운영 환경(GitHub Actions,
 * 네트워크 제약 없음)에서 첫 실행 시 사이트 구조가 예상과 다르면 실패할 수 있습니다.
 * 실패 시에는 기존 data/latest-maintenance-brief.json을 덮어쓰지 않고(커밋 단계까지
 * 못 감) 콘솔에 원인을 자세히 남기니, 처음 몇 번은 "Actions" 탭에서 실행 로그를 꼭 확인해
 * 주세요.
 *
 * 필요 환경변수: generate-insight.js와 동일 — AI_PROVIDER=claude면 ANTHROPIC_API_KEY,
 *              AI_PROVIDER=gemini(기본값)면 GEMINI_API_KEY (이미 등록된 Secret 재사용)
 * 실행 방법:     node scripts/generate-maintenance-brief.js
 * 실행 환경:     Node.js 18 이상 (내장 fetch 사용)
 */
 
const fs = require('fs');
const path = require('path');
 
const LIST_URL = 'https://cerik.re.kr/report/briefing';
const DETAIL_BASE = 'https://cerik.re.kr/report/briefing/';
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'latest-maintenance-brief.json');
 
const AI_PROVIDER = (process.env.AI_PROVIDER || 'gemini').trim().toLowerCase();
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const MODEL = AI_PROVIDER === 'claude' ? CLAUDE_MODEL : GEMINI_MODEL;
 
const UA = 'Mozilla/5.0 (compatible; BridgewonInsightBot/1.0; +https://github.com/bridgeone-m/BridgeOne_Data)';
 
// ---------------------------------------------------------------------------
// 1. 목록 페이지에서 최신 호 상세 링크 찾기
// ---------------------------------------------------------------------------
async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`페이지 요청 실패: HTTP ${res.status} (${url})`);
  return await res.text();
}
 
// HTML 태그를 걷어내 순수 텍스트만 남긴다(사이트 마크업이 바뀌어도 잘 버티도록, 특정
// CSS 클래스/셀렉터에 의존하지 않는 범용 방식을 택함).
function htmlToText(html) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|div|li|tr|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const entities = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&middot;': '·' };
  text = text.replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&middot;/g, m => entities[m]);
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').split('\n').map(l => l.trim()).filter(Boolean).join('\n');
  return text;
}
 
function findLatestDetailUrl(listHtml) {
  // "/report/briefing/1234" 형태의 상세 링크를 모두 찾아 가장 먼저 나오는(=목록 최상단=최신) 것을 사용.
  const matches = [...listHtml.matchAll(/href=["']([^"']*\/report\/briefing\/(\d+))["']/gi)];
  if (!matches.length) return null;
  const first = matches[0];
  const rawHref = first[1];
  const id = first[2];
  const absoluteUrl = rawHref.startsWith('http') ? rawHref : DETAIL_BASE + id;
  return { url: absoluteUrl, id };
}
 
function extractIssueMeta(detailText) {
  const issueMatch = detailText.match(/동향브리핑\s*(\d{3,5})\s*호/);
  const dateMatch = detailText.match(/(20\d{2})[.\-년]\s*(\d{1,2})[.\-월]\s*(\d{1,2})/);
  const issueNo = issueMatch ? issueMatch[1] : null;
  const issueDate = dateMatch ? `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}` : null;
  return { issueNo, issueDate };
}
 
// ---------------------------------------------------------------------------
// 2. AI 제공사 호출 계층 — scripts/generate-insight.js와 동일한 패턴/시그니처.
// ---------------------------------------------------------------------------
async function callAnthropicApi(prompt, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않습니다.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Claude API 호출 실패: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  const json = await res.json();
  return (json.content || []).map(b => b.text || '').join('').trim();
}
 
async function callGeminiApi(prompt, maxTokens) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 환경변수가 설정되어 있지 않습니다.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } }),
  });
  if (!res.ok) throw new Error(`Gemini API 호출 실패: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  const json = await res.json();
  const candidate = (json.candidates || [])[0];
  const parts = candidate && candidate.content && candidate.content.parts ? candidate.content.parts : [];
  return parts.map(p => p.text || '').join('').trim();
}
 
async function callAiProvider(prompt, maxTokens) {
  return AI_PROVIDER === 'claude' ? callAnthropicApi(prompt, maxTokens) : callGeminiApi(prompt, maxTokens);
}
 
// AI 응답에서 JSON 블록만 뽑아낸다(```json ... ``` 로 감싸 응답하는 경우 대비).
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('AI 응답에서 JSON을 찾지 못함: ' + text.slice(0, 200));
  return JSON.parse(candidate.slice(start, end + 1));
}
 
// ---------------------------------------------------------------------------
// 3. 메인 실행
// ---------------------------------------------------------------------------
async function main() {
  console.log('[1/5] CERIK 동향브리핑 목록 페이지 확인 중...');
  const listHtml = await fetchHtml(LIST_URL);
  const latest = findLatestDetailUrl(listHtml);
  if (!latest) throw new Error('목록 페이지에서 상세 링크를 찾지 못했습니다 — 사이트 구조가 바뀌었을 수 있습니다.');
  console.log(`  - 최신 호 상세 페이지: ${latest.url}`);
 
  console.log('[2/5] 최신 호 상세 페이지 내용 가져오는 중...');
  const detailHtml = await fetchHtml(latest.url);
  const detailText = htmlToText(detailHtml);
  if (detailText.length < 50) throw new Error('상세 페이지에서 의미 있는 텍스트를 추출하지 못했습니다(페이지가 비어있거나 구조가 크게 다름).');
  const { issueNo, issueDate } = extractIssueMeta(detailText);
  console.log(`  - 호수: ${issueNo || '(인식 실패)'}, 발행일: ${issueDate || '(인식 실패)'}, 텍스트 길이: ${detailText.length}자`);
 
  // 이미 이 호를 처리한 적이 있다면(=이전 결과와 issue_id 동일) 재호출하지 않고 종료(비용 절감).
  let prevData = null;
  try { prevData = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8')); } catch (e) { /* 최초 실행 등 — 무시 */ }
  if (prevData && prevData.issue_id === latest.id) {
    console.log(`[3/5] 이미 처리된 호(issue_id=${latest.id})입니다 — AI 호출 없이 종료합니다.`);
    return;
  }
 
  console.log('[3/5] AI로 유지보수 시장 관련성 판별 + 요약 생성 중...');
  const capped = detailText.slice(0, 6000);
  const prompt = `당신은 건설업 유지보수(재도장·방수·하자보수·리모델링·유지관리·개보수) 시장을 담당하는 애널리스트입니다.
아래는 한국건설산업연구원(CERIK) 동향브리핑 최신 호의 본문(또는 요약) 텍스트입니다.
 
[리포트 본문]
${capped}
 
지시사항:
1. 위 본문에 유지보수 시장(재도장, 방수, 하자보수, 리모델링, 유지관리, 개보수, 노후 공동주택/건축물 관리, 관련 정책·예산 등)과 직접 관련된 내용이 있는지 판단하세요.
2. 본문에 없는 내용을 추측하거나 창작하지 마세요 — 반드시 본문 안의 내용만 근거로 사용하세요.
3. 관련 내용이 있다면, 그것이 유지보수 시장에 긍정적(수요·예산·정책 확대 등)인지, 부정적(위축·규제·비용 부담 등)인지, 판단하기 애매한 중립인지 분류하세요.
4. 아래 JSON 형식으로만 답변하세요(다른 설명 문장 없이 JSON만):
 
{
  "relevant": true 또는 false,
  "signal": "positive" 또는 "negative" 또는 "neutral" (relevant가 false면 null),
  "summary": "실무진이 바로 읽을 수 있는 2~3문장 한국어 요약, 존댓말 (relevant가 false면 null)",
  "basis": "요약의 근거가 된 본문 속 핵심 문구나 문장 (relevant가 false면 null)"
}`;
 
  const raw = await callAiProvider(prompt, 700);
  const parsed = extractJson(raw);
 
  console.log(`[4/5] 판별 결과: relevant=${parsed.relevant}, signal=${parsed.signal || '-'}`);
 
  const output = {
    generated_at: new Date().toISOString(),
    model: MODEL,
    source: 'CERIK 한국건설산업연구원 동향브리핑',
    issue_id: latest.id,
    issue_no: issueNo,
    issue_date: issueDate,
    source_url: latest.url,
    relevant: !!parsed.relevant,
    signal: parsed.relevant ? (parsed.signal || 'neutral') : null,
    summary: parsed.relevant ? (parsed.summary || null) : null,
    basis: parsed.relevant ? (parsed.basis || null) : null,
  };
 
  console.log('[5/5] 결과 저장 중...');
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`완료: ${OUTPUT_PATH} 저장됨`);
}
 
if (require.main === module) {
  main().catch(err => {
    console.error('오류:', err.message);
    process.exit(1);
  });
}
 
module.exports = { htmlToText, findLatestDetailUrl, extractIssueMeta, extractJson };
