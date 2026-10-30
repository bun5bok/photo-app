#!/usr/bin/env bash
# 원본(origin)에 올린 뒤, 같은 파일 내용을 기관 운영본(deploy)에 새 커밋으로 반영한다.
# 운영본은 템플릿으로 만들어 커밋 이력이 원본과 달라서, 강제 푸시 없이 운영본 위에 이어 붙인다.
# 실행: bash tools/deploy.sh
set -e
cd "$(dirname "$0")/.."

git push origin main
git fetch deploy main

tree=$(git rev-parse 'HEAD^{tree}')
if [ "$tree" = "$(git rev-parse 'deploy/main^{tree}')" ]; then
  echo "운영본이 이미 최신입니다."
  exit 0
fi

commit=$(git log -1 --format=%B HEAD | git commit-tree "$tree" -p deploy/main)
git push deploy "$commit:refs/heads/main"
echo "운영본에 반영했습니다: $commit"
