# Perflow — Agent Handoff Log

**Last Updated:** YYYY-MM-DD

---

## 1. Purpose

This document records the transfer of tasks, implementation results, review feedback, and integration outcomes between Claude A and Claude B.

It serves as a persistent communication record across separate Claude Code sessions.

---

## 2. Handoff Workflow

### Stage 1 — Assignment

Claude A creates a task in TASK_QUEUE.md.

Claude A provides:
- Task ID
- Objective
- Context
- Requirements
- Relevant modules
- Restrictions
- Acceptance criteria

### Stage 2 — Acknowledgment

Claude B confirms:
- Understanding of the task.
- Planned implementation.
- Potential dependencies.
- Identified risks or blockers.

### Stage 3 — Implementation

Claude B:
- Implements the requested feature.
- Runs relevant tests.
- Inspects the Git diff.
- Commits completed changes.
- Prepares a completion report.

### Stage 4 — Submission

Claude B submits its results to Claude A.

### Stage 5 — Review

Claude A:
- Inspects the commit.
- Reviews the implementation.
- Checks acceptance criteria.
- Identifies issues.
- Approves or requests revisions.

### Stage 6 — Integration

The project owner or authorized integration process merges approved work.

The final merge reference is recorded.

---

## 3. Handoff Entry Template

### HANDOFF — HO-XXX

**Date:** YYYY-MM-DD  
**Task ID:** PF-XXX  
**From:** Claude A / Claude B  
**To:** Claude A / Claude B  
**Status:** PENDING

#### 1. Assignment / Summary

Describe the purpose of the handoff.

#### 2. Context

Provide the necessary background.

#### 3. Work Completed

List verified implementation changes.

#### 4. Modified Files

- path/to/file

#### 5. Git Information

**Branch:**  
**Commit:**  
**Base Branch:**  

#### 6. Testing

**Tests Executed:**
- 

**Results:**
- 

#### 7. Outstanding Issues

- None / List outstanding issues.

#### 8. Required Next Action

Specify exactly what the receiving agent must do.

#### 9. Review Result

**Reviewer:**  
**Decision:** PENDING

---

## 4. Handoff History

### HO-001 — Initial Coordination Setup

**Date:** YYYY-MM-DD  
**From:** Project Owner  
**To:** Claude A and Claude B  
**Status:** IN PROGRESS

#### Objective

Establish the shared documentation and coordination protocol for Perflow's two-agent development workflow.

#### Deliverables

- CLAUDE.md
- PROJECT_STATUS.md
- TASK_QUEUE.md
- ARCHITECTURE_DECISIONS.md
- HANDOFF_LOG.md

#### Required Next Action

Claude A must inspect the repository and establish an accurate project baseline.

Claude B must review the project instructions and prepare for implementation assignments.

---

## 5. Review Decision Definitions

### APPROVED
The implementation satisfies requirements and can proceed to integration.

### APPROVED WITH MINOR CHANGES
The implementation is acceptable but requires small corrections.

### REVISION REQUIRED
The implementation does not satisfy one or more acceptance criteria.

### REJECTED
The implementation is unsuitable and requires a different approach.

### BLOCKED
The review cannot proceed due to missing information or dependencies.

---

## 6. Communication Rules

1. Every substantial handoff must reference a Task ID.
2. Do not claim changes exist without checking the repository.
3. Include commit hashes whenever available.
4. Clearly identify uncommitted work.
5. Include test results.
6. Identify unresolved issues.
7. Do not silently discard review feedback.
8. Preserve previous handoff records.
9. Avoid recording sensitive information or credentials.
10. Never treat a proposed action as a completed action.

---

## 7. Session Continuity

At the beginning of a new session, agents should inspect:
- PROJECT_STATUS.md
- TASK_QUEUE.md
- ARCHITECTURE_DECISIONS.md
- Recent entries in HANDOFF_LOG.md

Agents must verify the current Git branch and working directory before continuing previous work.

A handoff entry is a communication record, not proof that another agent has already received or acknowledged it.