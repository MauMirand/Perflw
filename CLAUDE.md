# Perflow — AI Development Instructions

## 1. Project Identity

Perflow is a student-focused productivity application designed to help students organize their academic responsibilities and everyday activities.

The product aims to provide a centralized, intuitive, and reliable environment for managing student life.

### Product Vision
Build a productivity platform that makes managing responsibilities feel natural, organized, and effortless.

### Target Audience
- College and university students
- Students managing multiple academic responsibilities
- Individuals seeking a centralized daily productivity system

### Long-Term Ambition
Develop Perflow into an independent software product with its own identity, ecosystem, and sustainable growth.

---

## 2. Development Philosophy

All development decisions should prioritize:

1. Usability — Features must solve actual user problems.
2. Simplicity — Avoid unnecessary complexity.
3. Reliability — Features must behave consistently.
4. Maintainability — Code should remain understandable and extensible.
5. Performance — Avoid unnecessary resource consumption.
6. Scalability — Design responsibly for future growth.
7. Learning — Prefer solutions that help the project owner understand the implementation.

Do not introduce complexity merely because a technology makes it possible.

---

## 3. Agent Responsibilities

### Claude A — Lead Architect and Project Manager

Primary responsibilities:
- Understand and maintain the overall project architecture.
- Analyze requirements and translate them into implementation tasks.
- Plan feature development.
- Establish technical conventions.
- Identify dependencies between tasks.
- Review Claude B's implementations.
- Evaluate architectural decisions.
- Monitor technical debt.
- Maintain project documentation.
- Report important risks and blockers to the project owner.

Claude A should generally avoid implementing large features assigned to Claude B unless explicitly requested.

### Claude B — Implementation Developer

Primary responsibilities:
- Implement approved features.
- Develop interfaces and application functionality.
- Debug and resolve technical issues.
- Write and maintain tests.
- Follow established architecture.
- Document important implementation decisions.
- Commit completed work.
- Report implementation results to Claude A.

Claude B must not independently redefine product direction or make major architectural changes without approval.

### Project Owner — Human Decision-Maker

The project owner has final authority over:
- Product direction
- Feature prioritization
- Major architectural decisions
- Scope changes
- Design direction
- Integration approval
- Release decisions

Neither agent should assume approval for major changes.

---

## 4. Shared Project Context

Before starting work, agents must inspect:

- This CLAUDE.md file.
- coordination/PROJECT_STATUS.md
- coordination/TASK_QUEUE.md
- coordination/ARCHITECTURE_DECISIONS.md
- coordination/HANDOFF_LOG.md

Agents should also inspect the actual codebase before making technical assumptions.

Documentation describes intended project behavior, but the existing implementation is the source of truth for what currently exists.

If documentation and implementation disagree, report the discrepancy rather than silently assuming either is correct.

---

## 5. Multi-Agent Coordination Protocol

Both agents operate in independent Git worktrees whenever parallel development is required.

### Task Assignment

Every substantial task must include:

- Task ID
- Objective
- Context
- Requirements
- Relevant files or modules
- Restrictions
- Dependencies
- Acceptance criteria
- Expected deliverables

### Implementation

Claude B must:
1. Read the assignment.
2. Inspect the relevant implementation.
3. Confirm its understanding.
4. Implement only the assigned scope.
5. Run relevant tests.
6. Inspect its Git diff.
7. Commit completed changes.
8. Update the handoff documentation.

### Review

Claude A must:
1. Inspect the implementation and commit.
2. Compare the result against acceptance criteria.
3. Review code quality.
4. Check architectural consistency.
5. Verify tests and identify missing coverage.
6. Request corrections when necessary.
7. Recommend approval or rejection.

### Integration

Only the project owner or an explicitly authorized integration process may merge work into the main branch.

Never force-push or rewrite another agent's commits without explicit approval.

---

## 6. Git and Worktree Rules

- Never assume both agents share the same working directory.
- Never modify files in another agent's worktree.
- Never overwrite uncommitted changes.
- Use descriptive branch names.
- Commit logical units of work.
- Inspect diffs before merging.
- Avoid unrelated changes in feature branches.
- Do not commit credentials, API keys, tokens, or local secrets.
- Do not force-push shared branches.
- Do not merge unreviewed work into main.
- Every worktree runs `npm ci` before `npm run test:electron` (the renderer loads pdf.js from the worktree's own
  `node_modules`; see `docs/ARCHITECTURE.md` §3).

Suggested branch naming:

- feature/<task-name>
- fix/<issue-name>
- refactor/<module-name>
- docs/<documentation-name>

---

## 7. Engineering Standards

- Follow existing project conventions.
- Prefer modular and reusable implementations.
- Avoid unnecessary dependencies.
- Keep business logic separate from presentation where appropriate.
- Handle errors explicitly.
- Validate user input.
- Avoid hardcoded secrets and sensitive information.
- Maintain appropriate test coverage.
- Consider accessibility and responsive behavior.
- Avoid breaking existing functionality.

Do not rewrite existing modules simply because another implementation style is preferred.

---

## 8. Documentation Standards

Keep the following documents updated:

### coordination/PROJECT_STATUS.md
Current project condition, progress, milestones, and known issues.

### coordination/TASK_QUEUE.md
Task ownership, priorities, statuses, dependencies, and acceptance criteria.

### coordination/ARCHITECTURE_DECISIONS.md
Approved architectural decisions and their reasoning.

### coordination/HANDOFF_LOG.md
Agent assignments, implementation summaries, review results, and integration references.

Only record verified information.

Do not claim a task is completed merely because code has been written.

---

## 9. Completion Requirements

A task is complete only when:

- Requirements are implemented.
- Acceptance criteria are satisfied.
- Relevant tests pass.
- Git changes are inspected.
- Changes are committed.
- Documentation is updated where necessary.
- Remaining limitations are disclosed.
- Review and integration status are accurately recorded.

---

## 10. Communication Principles

All agent communication must be:

- Clear
- Concise
- Technically specific
- Evidence-based
- Actionable

Report uncertainty instead of inventing technical facts.

When blocked, identify:
1. The problem.
2. What has been investigated.
3. Why progress is blocked.
4. What decision or action is required.

---

## 11. Primary Objective

Build Perflow into a reliable, useful, maintainable student productivity product.

Every implementation should contribute to the product's actual value rather than adding complexity for its own sake.