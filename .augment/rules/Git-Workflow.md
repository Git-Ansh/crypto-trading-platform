---
type: "always_apply"
---

# Git Workflow Guide for Crypto Trading Platform

**Universal Workflow for All Bug Fixes and Feature Implementations**

---

## Standard Git Workflow

### Step 1: Create GitHub Issue

**Before writing any code, create a detailed GitHub issue:**

```bash
# Navigate to GitHub repository
# Click "Issues" → "New Issue"
```

**Issue Template:**
```markdown
## Title
[Type]: Brief description

## Description
Detailed explanation of the feature/bug

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Technical Details
- Files to modify: `path/to/file.ts`
- Dependencies: Issue #X, Issue #Y
- Estimated effort: X hours

## Testing Plan
- [ ] Unit tests
- [ ] Integration tests
- [ ] Manual testing steps
```

**Labels to Add:**
- Priority: `critical`, `high`, `medium`, `low`
- Type: `bug`, `feature`, `refactor`, `docs`, `test`
- Complexity: `small`, `medium`, `large`
- Area: `frontend`, `backend`, `infrastructure`, `database`

---

### Step 2: Create Feature Branch

**Branch Naming Convention:**
```bash
# For features
feature/issue-number-brief-description

# For bug fixes
bugfix/issue-number-brief-description

# For refactoring
refactor/issue-number-brief-description

# For documentation
docs/issue-number-brief-description
```

**Commands:**
```bash
# Ensure you're on main and up to date
git checkout main
git pull origin main

# Create and checkout new branch
git checkout -b feature/1-pool-production-testing

# Verify branch
git branch
```

---

### Step 3: Implement Changes

**Commit Message Convention (Conventional Commits):**
```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `refactor`: Code refactoring
- `test`: Adding tests
- `docs`: Documentation
- `style`: Code style changes
- `perf`: Performance improvements
- `chore`: Maintenance tasks

**Examples:**
```bash
# Feature commit
git commit -m "feat(pool): add production testing suite for 50+ bots"

# Bug fix commit
git commit -m "fix(auth): resolve token refresh race condition"

# Refactor commit
git commit -m "refactor(bot-orchestrator): extract docker service to separate module"

# Test commit
git commit -m "test(api-gateway): add unit tests for auth middleware"

# Documentation commit
git commit -m "docs(pool): update pool system usage guide"
```

**Commit Best Practices:**
- Make small, focused commits
- Commit working code (tests should pass)
- Write descriptive commit messages
- Reference issue number in commit body if needed

---

### Step 4: Push and Create Pull Request

**Push Branch:**
```bash
# Push to remote
git push origin feature/1-pool-production-testing

# If branch doesn't exist remotely yet
git push -u origin feature/1-pool-production-testing
```

**Create Pull Request:**
```bash
# Navigate to GitHub repository
# Click "Pull Requests" → "New Pull Request"
# Select your branch
```

**PR Template:**
```markdown
## Description
Brief description of changes

## Related Issue
Closes #1

## Changes Made
- Change 1
- Change 2
- Change 3

## Testing
- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing completed
- [ ] All tests passing

## Screenshots (if applicable)
[Add screenshots]

## Checklist
- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Documentation updated
- [ ] No breaking changes (or documented)
- [ ] Tests pass locally
- [ ] Ready for review
```

---

### Step 5: Code Review

**Self-Review Checklist:**
- [ ] Code is clean and readable
- [ ] No console.logs or debug code
- [ ] Error handling implemented
- [ ] Edge cases covered
- [ ] Tests written and passing
- [ ] Documentation updated
- [ ] No security vulnerabilities
- [ ] Performance considered

**Request Review:**
- Assign reviewers (if team)
- Add labels
- Link to issue
- Wait for approval

---

### Step 6: Merge Pull Request

**Before Merging:**
```bash
# Ensure all tests pass in CI
# Ensure no merge conflicts
# Ensure all review comments addressed
```

**Merge Options:**
1. **Squash and Merge** (Recommended for feature branches)
   - Combines all commits into one
   - Keeps main branch clean
   - Use for most features

2. **Rebase and Merge** (For clean history)
   - Replays commits on top of main
   - Maintains individual commits
   - Use for important features

3. **Merge Commit** (Preserves all history)
   - Creates merge commit
   - Keeps all branch commits
   - Use rarely

**After Merge:**
```bash
# Delete remote branch (GitHub does this automatically)
# Delete local branch
git checkout main
git pull origin main
git branch -d feature/1-pool-production-testing
```

---

### Step 7: Close Issue

**Verify Deployment:**
```bash
# For frontend (Vercel)
# Check deployment status on Vercel dashboard

# For backend (VPS)
ssh user@vps
sudo systemctl status api-gateway
sudo systemctl status bot-orchestrator
```

**Close Issue:**
- Navigate to issue on GitHub
- Add comment: "Resolved in PR #X"
- Close issue

---

## Quick Reference Commands

### Daily Workflow
```bash
# Start of day - update main
git checkout main
git pull origin main

# Create feature branch
git checkout -b feature/123-new-feature

# Make changes, commit frequently
git add .
git commit -m "feat(scope): description"

# Push to remote
git push origin feature/123-new-feature

# After PR merged
git checkout main
git pull origin main
git branch -d feature/123-new-feature
```

### Handling Merge Conflicts
```bash
# Update your branch with latest main
git checkout feature/123-new-feature
git fetch origin
git rebase origin/main

# If conflicts occur
# 1. Resolve conflicts in files
# 2. Mark as resolved
git add <resolved-files>
git rebase --continue

# Force push (only for feature branches!)
git push --force-with-lease origin feature/123-new-feature
```

### Undoing Changes
```bash
# Undo last commit (keep changes)
git reset --soft HEAD~1

# Undo last commit (discard changes)
git reset --hard HEAD~1

# Discard all local changes
git checkout .

# Discard specific file
git checkout -- path/to/file
```

---

## Branch Protection Rules (Recommended)

**For `main` branch:**
- Require pull request reviews (1+ approvals)
- Require status checks to pass (CI tests)
- Require branches to be up to date
- Require linear history (squash or rebase)
- Do not allow force pushes
- Do not allow deletions

---

## Example: Complete Workflow

```bash
# 1. Create issue on GitHub (#42: Add pool metrics dashboard)

# 2. Create branch
git checkout main
git pull origin main
git checkout -b feature/42-pool-metrics-dashboard

# 3. Implement changes
# ... make changes to files ...

# 4. Commit changes
git add apps/web/src/components/pool-metrics.tsx
git commit -m "feat(pool): add pool metrics dashboard component"

git add apps/web/src/pages/pool-management.tsx
git commit -m "feat(pool): integrate metrics dashboard into pool management page"

git add apps/web/src/hooks/use-pool-metrics.ts
git commit -m "feat(pool): add usePoolMetrics hook for real-time data"

# 5. Push branch
git push -u origin feature/42-pool-metrics-dashboard

# 6. Create PR on GitHub
# - Title: "Add pool metrics dashboard"
# - Description: "Closes #42"
# - Request review

# 7. Address review comments
# ... make changes ...
git add .
git commit -m "refactor(pool): address PR review comments"
git push origin feature/42-pool-metrics-dashboard

# 8. Merge PR (via GitHub UI)

# 9. Clean up
git checkout main
git pull origin main
git branch -d feature/42-pool-metrics-dashboard

# 10. Close issue #42 on GitHub
```

---

## Tips for Success

1. **Always create an issue first** - Helps with planning and tracking
2. **Keep branches short-lived** - Merge within 1-3 days
3. **Commit frequently** - Small commits are easier to review
4. **Write descriptive messages** - Future you will thank you
5. **Test before pushing** - Don't break CI
6. **Review your own PR first** - Catch obvious issues
7. **Keep PRs focused** - One feature/fix per PR
8. **Update documentation** - Code without docs is incomplete
9. **Link issues and PRs** - Maintains traceability
10. **Delete merged branches** - Keeps repository clean

---

**End of Guide**
