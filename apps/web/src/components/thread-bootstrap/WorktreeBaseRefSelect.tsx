// T3-CUSTOM(expbkt3): reusable exact Local/Origin worktree base-ref picker.
import type { EnvironmentId, VcsRef, WorktreeBaseRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { buildBaseRefChoices } from "../../lib/baseRefChoices";
import { useBranches } from "../../state/queries";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export interface WorktreeBaseRefOption {
  readonly value: string;
  readonly label: string;
  readonly baseRef: WorktreeBaseRef;
}

function remoteBranchName(ref: VcsRef): string {
  return ref.remoteName && ref.name.startsWith(`${ref.remoteName}/`)
    ? ref.name.slice(ref.remoteName.length + 1)
    : ref.name.replace(/^origin\//, "");
}

export function buildWorktreeBaseRefOptions(
  refs: ReadonlyArray<VcsRef>,
): ReadonlyArray<WorktreeBaseRefOption> {
  const localRefs = refs.filter((ref) => ref.isRemote !== true);
  const originRefs = refs.filter((ref) => ref.isRemote === true && ref.remoteName === "origin");
  return buildBaseRefChoices(localRefs, originRefs).flatMap((choice) => {
    const options: WorktreeBaseRefOption[] = [];
    if (choice.local) {
      options.push({
        value: `local:${choice.local.name}`,
        label: `Local · ${choice.local.name}`,
        baseRef: { kind: "branch", source: "local", branch: choice.local.name },
      });
    }
    if (choice.remote) {
      const branch = remoteBranchName(choice.remote);
      options.push({
        value: `origin:${branch}`,
        label: `Origin · ${branch}`,
        baseRef: { kind: "branch", source: "origin", branch },
      });
    }
    return options;
  });
}

export function worktreeBaseRefValue(baseRef: WorktreeBaseRef | null): string {
  if (baseRef === null) return "inherit";
  if (baseRef.kind === "repository-default") return `default:${baseRef.source}`;
  return `${baseRef.source}:${baseRef.branch}`;
}

export function parseWorktreeBaseRefValue(value: string): WorktreeBaseRef | null {
  if (value === "inherit") return null;
  if (value === "default:local" || value === "default:origin") {
    return {
      kind: "repository-default",
      source: value === "default:origin" ? "origin" : "local",
    };
  }
  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1) return null;
  const source = value.slice(0, separator);
  const branch = value.slice(separator + 1);
  return source === "local" || source === "origin" ? { kind: "branch", source, branch } : null;
}

export interface WorktreeBaseRefSelectProps {
  readonly environmentId: EnvironmentId | null;
  readonly workspaceRoot: string | null;
  readonly value: WorktreeBaseRef | null;
  readonly onValueChange: (value: WorktreeBaseRef | null) => void;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
  readonly includeInherit?: boolean;
}

export function WorktreeBaseRefSelect({
  environmentId,
  workspaceRoot,
  value,
  onValueChange,
  ariaLabel,
  disabled = false,
  includeInherit = true,
}: WorktreeBaseRefSelectProps) {
  const refsQuery = useBranches({ environmentId, cwd: workspaceRoot });
  const options = useMemo(
    () => buildWorktreeBaseRefOptions(refsQuery.data?.refs ?? []),
    [refsQuery.data?.refs],
  );

  return (
    <Select
      value={worktreeBaseRefValue(value)}
      disabled={disabled}
      onValueChange={(nextValue) => {
        if (nextValue === null) return;
        const parsed = parseWorktreeBaseRefValue(nextValue);
        if (parsed !== null || nextValue === "inherit") onValueChange(parsed);
      }}
    >
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {includeInherit ? <SelectItem value="inherit">Use app default</SelectItem> : null}
        <SelectItem value="default:local">Repository default · Local</SelectItem>
        <SelectItem value="default:origin">Repository default · Origin</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
