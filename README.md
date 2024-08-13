# SSM Commander

## CLI tool to simplify the management and execution of AWS SSM commands. Easily create, list, and run your SSM commands with an interactive prompt.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

### todo

- OS 타입
- 바이너리 존재 확인
- credential 파싱
  - keys, region
- ec2 정보 불러오기
- create
  - inquirer
    - profile
    - region
    -
- options
- save command
- list
- run
- profile의 전체 내용을 저장할 필요가 없음. getProfile의 성공 여부만 판단해도 될듯
- getInstances의 에러처리에 대해 고민 필요
