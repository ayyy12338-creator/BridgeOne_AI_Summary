name: Weekly Maintenance Market Brief

# CERIK 동향브리핑은 보통 매주 금요일 발행됩니다. 발행 시차를 감안해 토요일 오전(KST)에
# 실행하도록 설정했습니다 + 수동 실행(Actions 탭에서 "Run workflow")도 지원합니다.
# ⚠ cron은 GitHub 서버 부하에 따라 예정 시각보다 몇 분~수십 분 늦게 실행될 수 있습니다.
# 한국 시간(KST) 토요일 오전 8:00 목표 → UTC 금요일 23:00로 설정 (KST = UTC+9)
on:
  schedule:
    - cron: '0 23 * * 5'
  workflow_dispatch: {}

permissions:
  contents: write   # data/latest-maintenance-brief.json 커밋을 위해 필요

jobs:
  generate-maintenance-brief:
    runs-on: ubuntu-latest
    steps:
      - name: 저장소 체크아웃
        uses: actions/checkout@v4

      - name: Node.js 설치
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: 유지보수 시장 동향 브리핑 생성
        env:
          AI_PROVIDER: ${{ vars.AI_PROVIDER }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
        run: node scripts/generate-maintenance-brief.js

      - name: 결과 커밋 및 푸시
        run: |
          git config user.name "bridgeone-insight-bot"
          git config user.email "actions@github.com"
          git add data/latest-maintenance-brief.json
          git diff --cached --quiet && echo "변경 없음 — 커밋 생략" || git commit -m "chore: 유지보수 시장 동향 브리핑 갱신 ($(date -u +%Y-%m-%d))"
          git push
