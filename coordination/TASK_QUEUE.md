# Perflow — Task Queue

**Last Updated:** YYYY-MM-DD  
**Task Manager:** Claude A  
**Implementation Agent:** Claude B

---

## 1. Task Status Definitions

| Status | Meaning |
|---|---|
| BACKLOG | Identified but not scheduled |
| READY | Requirements defined and ready for assignment |
| ASSIGNED | Ownership established |
| IN PROGRESS | Implementation underway |
| BLOCKED | Cannot proceed without intervention |
| REVIEW | Awaiting technical review |
| REVISION | Changes requested by reviewer |
| APPROVED | Review completed successfully |
| INTEGRATED | Merged into the main development branch |
| CANCELLED | No longer required |

Only use INTEGRATED when the changes have actually been merged.

---

## 2. Priority Definitions

| Priority | Meaning |
|---|---|
| P0 — Critical | Prevents development or compromises essential functionality |
| P1 — High | Important to the current milestone |
| P2 — Medium | Valuable improvement |
| P3 — Low | Optional enhancement |

---

## 3. Active Tasks

No active tasks have been assigned yet.

| ID | Task | Priority | Owner | Status |
|---|---|---|---|---|
| — | No active tasks | — | — | — |

---

## 4. Backlog

Tasks awaiting prioritization or clarification.

| ID | Task | Priority | Notes |
|---|---|---|---|
| PF-001 | Inspect and document existing architecture | P1 | Establish technical baseline |
| PF-002 | Audit existing application functionality | P1 | Identify implemented features |
| PF-003 | Identify technical debt and risks | P2 | Based on repository inspection |

These are initial investigation tasks, not assumptions that problems already exist.

---

## 5. Task Assignment Template

Use this structure whenever Claude A delegates a task.

### TASK: PF-XXX — Task Name

**Status:** READY  
**Priority:** P1  
**Assigned To:** Claude B  
**Created By:** Claude A  
**Created:** YYYY-MM-DD

#### Objective
Describe the intended result.

#### Context
Explain why the task is necessary.

#### Requirements
- Requirement 1
- Requirement 2
- Requirement 3

#### Relevant Files
List known files and modules.

#### Dependencies
List prerequisite tasks or systems.

#### Restrictions
- Avoid unrelated modifications.
- Preserve existing conventions.
- Do not change architectural foundations without approval.

#### Acceptance Criteria
- [ ] Requirement satisfied.
- [ ] Implementation behaves as expected.
- [ ] Relevant tests pass.
- [ ] Changes committed.
- [ ] Documentation updated if necessary.

#### Deliverables
- Implementation summary.
- Modified files.
- Test results.
- Git commit hash.
- Known limitations.

#### Review
**Reviewed By:**  
**Decision:** Pending

---

## 6. Task History

Move completed or cancelled tasks into this section rather than deleting them.

| ID | Task | Final Status | Commit | Date |
|---|---|---|---|---|
| — | No completed tasks recorded | — | — | — |

---

## 7. Assignment Rules

1. Claude A is responsible for task definition and prioritization.
2. Claude B implements assigned tasks.
3. Every substantial implementation must have a task ID.
4. Avoid assigning overlapping modifications to both agents.
5. Tasks must have clear acceptance criteria.
6. Blocked tasks must explain the reason for the blockage.
7. Review must happen before integration.
8. Only the project owner or authorized integration process approves main-branch merges.

---

## 8. Parallel Development Rules

Tasks can run simultaneously only when their scopes are sufficiently independent.

Before parallel assignment, verify:
- File ownership does not overlap.
- Dependencies are available.
- Shared interfaces are defined.
- Database or schema changes are coordinated.
- Integration requirements are understood.

When conflicts are unavoidable, sequence the tasks rather than risking simultaneous changes.

---

## 9. Task Queue Maintenance

Claude A must:
- Keep assignments current.
- Remove duplicate backlog entries.
- Identify dependencies.
- Prioritize tasks based on product value.
- Report blocked work.
- Update task statuses after verified progress.

Claude B must not mark its own task INTEGRATED.

Only mark tasks APPROVED after review and INTEGRATED after actual merging.