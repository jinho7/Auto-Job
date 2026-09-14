# Auto-Job

채용 공고 수집 → Notion 정리 → 지원서 작성(인적사항 + 자기소개서) → **임시저장**까지 AI가 처리하는 취업 자동화 도구.
최종 제출은 항상 사람이 합니다. 설계와 로드맵은 [PLAN.md](PLAN.md)에 있습니다.

> 현재 단계: **설정과 입력 도구 완료** (설정 화면, 내 정보 편집, Notion 연결, 브라우저 드라이버와 제출 차단).
> 공고 수집(`collect`)과 지원서 작성(`apply`)은 아직 구현 전입니다.

## 요구 사항
- Node.js 22 이상
- 브라우저: [Aside](https://aside.com) (기본) 또는 Google Chrome

## 시작하기

```bash
npm install
npm link                    # 선택: 어디서든 `autojob` 명령 사용
autojob ui                  # 설정 화면이 브라우저로 열린다 (처음이면 파일도 자동 생성)
```

**모든 설정과 내 정보는 화면(`autojob ui`)에서 입력할 수 있습니다.** 파일을 직접 고칠 필요가 없습니다.
터미널이 편하면 같은 일을 `autojob settings`, `autojob profile edit` 으로도 할 수 있습니다.

## 설정 화면 — `autojob ui`
- 내 컴퓨터(127.0.0.1)에서만 열립니다. 주소에 실행할 때마다 바뀌는 접속 토큰이 붙어 있어서, 다른 웹사이트가 몰래 설정을 바꿀 수 없습니다.
- 입력하면 바로 저장되고, 형식이 틀리면 칸 아래에 이유가 나옵니다.

| 메뉴 | 내용 |
|---|---|
| 내 정보 (6개 섹션) | `profile/schema.yaml`을 따라 자동으로 만들어지는 입력 화면. 목록 추가/삭제, 증명사진 올리기 |
| 검색 키워드 · 수집 사이트 · 고용형태 | 공고 검색 조건 |
| 기업 구분 · 회사 직접 지정 | 모을 기업 구분과 "작성중" 표시 (자소설닷컴 달력처럼) |
| 자기소개서 문체 | 끝맺음, 소제목, 가운뎃점, 블라인드, 쓰지 않을 표현 |
| Notion | 연결 방법 안내 → 토큰 입력(틀린 토큰은 저장 안 됨) → DB 목록에서 고르기 → 속성 매칭 검사와 후보 자동 적용 |
| 브라우저 | 종류 선택, 자동화 브라우저 열기(로그인 해두기), 연결 테스트 |
| AI 연결 · 제출 차단 문구 | AI 백엔드와 API 키, 차단할 버튼 문구 |

토큰과 API 키는 `.env`(권한 600, git 제외)에 저장되고 화면에는 `ntn_abc…wxyz`처럼 가려서만 보입니다.

## 설정 — `autojob settings`
인자 없이 실행하면 메뉴가 열립니다. 바꾼 내용은 바로 `settings.yaml`에 저장되고, 형식이 틀리면 저장하지 않습니다.

| 메뉴 | 내용 |
|---|---|
| 검색 키워드 | 공고 검색어 추가/삭제 |
| 수집 사이트 | 사람인, 잡코리아, 원티드, 인크루트, 캐치, 자소설닷컴 켜고 끄기 |
| 고용형태 | 신입, 인턴, 채용연계형 인턴 등. 경력직 제외 여부 |
| 기업 구분 | 대기업, 유명IT, 금융, 공기업, 중견, 외국계, 스타트업, 중소를 포함할지, Notion에 "작성중"으로 둘지 |
| 회사 직접 지정 | 항상 포함, 항상 제외, 작성중으로 둘 회사 |
| Notion | 공고를 정리할 DB(링크 붙여넣기), DB 속성 이름, 옵션 이름 맞추기 |
| 자기소개서 문체 | 끝맺음, 소제목, 가운뎃점, 블라인드, 쓰지 않을 표현 |
| 브라우저 / 제출 차단 문구 / AI 연결 | 드라이버 선택, 차단 문구 목록, AI 백엔드 |

스크립트용 명령도 있습니다.

```bash
autojob settings show [경로]                       # 예: autojob settings show collect
autojob settings set browser.driver chrome
autojob settings add collect.keywords 백엔드 "Spring Boot"
autojob settings remove collect.keywords 백엔드
```

## 내 정보 — `autojob profile`
입력할 항목은 [profile/schema.yaml](profile/schema.yaml)에 정의되어 있습니다. 편집기, 검사, 빈 틀 생성, 지원서 자동 입력이 모두 이 파일을 따르므로, **항목을 추가하거나 바꾸려면 이 파일만 고치면 됩니다.**

| 명령 | 설명 |
|---|---|
| `autojob profile edit [섹션]` | 대화형 편집기. 목록(대학교, 자격증, 자소서 소재 등)은 추가/수정/삭제 |
| `autojob profile show [섹션] [--filled]` | 입력한 내용 보기 |
| `autojob profile check` | 필수 항목, 날짜/연락처 형식, 정의에 없는 키(오타) 검사 |
| `autojob profile set <경로> <값>` | 값 하나 바로 넣기 |
| `autojob profile add <목록> key=값 ...` | 목록에 항목 추가 |
| `autojob profile remove <목록.번호>` | 목록 항목 삭제 |
| `autojob profile schema` | 입력 가능한 항목과 경로 보기 |

```bash
autojob profile set basic.phone 010-1234-5678
autojob profile add extras.certificates name=정보처리기사 date=2025.06.13
autojob profile remove extras.certificates.0
```

섹션: `basic`(기본정보), `education`(학력/연구), `career`(경력/교육/NCS), `extras`(어학/자격/기타), `target`(희망 조건), `stories`(자소서 소재)

- 값이 없는 항목은 비워 두세요. AI는 빈 값을 추정해서 채우지 않습니다.
- 증명사진 같은 파일은 `profile/me/files/`에 넣고 파일 이름을 입력합니다.
- `profile/me/*.yaml`을 직접 편집해도 됩니다. 저장할 때 주석은 보존됩니다.

## 브라우저와 제출 차단

| 명령 | 설명 |
|---|---|
| `autojob browser open [url]` | 자동화 전용 프로필로 브라우저 열기. 채용 사이트에 미리 로그인해 두면 유지됨 |
| `autojob browser test` | 가짜 지원서로 입력 기능과 제출 차단 검증 |

- 평소 쓰는 브라우저 프로필과 분리된 **자동화 전용 프로필**(`~/.autojob/browser-profiles/`)을 씁니다.
- 제출 차단은 3중입니다.
  1. 페이지 안에서 금지 문구 버튼 클릭과 폼 제출을 막음
  2. 클릭 명령이 누르기 전에 문구를 검사해 거부
  3. 뒤로가기, 새로고침, 페이지 나가기 차단

## 개인 데이터
`settings.yaml`, `profile/me/`, `data/`, `.env`는 git에 올라가지 않습니다.
환경 변수 `AUTOJOB_HOME`을 지정하면 이 파일들을 다른 폴더에 둘 수 있습니다(여러 프로필 관리).

## 개발

```bash
npm test            # 단위 테스트
npm run typecheck
```
