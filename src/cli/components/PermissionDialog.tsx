/**
 * PermissionDialog — overlay permission prompt with arrow-key navigation.
 * Matches claude-code's PermissionPrompt + PermissionDialog components.
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionPrompt } from "../app-state.ts";

function buildOptions(toolName: string, scope?: string) {
  return [
    { value: "allow", label: "Yes" },
    {
      value: "allow_always",
      label: scope
        ? `Yes, and don't ask again for ${toolName}(${scope})`
        : `Yes, and don't ask again for ${toolName}`,
    },
    { value: "deny", label: "No, tell Wings what to do differently" },
  ];
}

export function PermissionDialog({
  permission,
  onUpdate,
  onResolve,
}: {
  permission: PermissionPrompt;
  onUpdate: (p: PermissionPrompt) => void;
  onResolve: (response: string) => void;
}) {
  const options = buildOptions(permission.toolName, permission.scope);

  useInput((char, key) => {
    if (key.upArrow) {
      onUpdate({ ...permission, selected: (permission.selected - 1 + options.length) % options.length });
    } else if (key.downArrow) {
      onUpdate({ ...permission, selected: (permission.selected + 1) % options.length });
    } else if (key.return) {
      onResolve(options[permission.selected]!.value);
    } else if (char === "y" || char === "Y") {
      onResolve("allow");
    } else if (char === "n" || char === "N" || key.escape) {
      onResolve("deny");
    }
  });

  const input = permission.toolInput;
  const desc = input["description"] as string | undefined;
  const cmd = permission.toolName === "bash"
    ? (input["command"] as string) ?? ""
    : permission.toolName === "write" || permission.toolName === "edit" || permission.toolName === "read"
    ? (input["file_path"] as string) ?? ""
    : "";

  return (
    <Box flexDirection="column" paddingY={1}>
      {desc ? <Text dimColor>Description: {desc}</Text> : null}
      <Text dimColor>{permission.toolName}{cmd ? `(${cmd.slice(0, 80)})` : ""}</Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((opt, i) => (
          <Text key={i} dimColor={i !== permission.selected}>
            {i === permission.selected ? `❯ ${opt.label}` : `  ${opt.label}`}
          </Text>
        ))}
      </Box>
      <Text> </Text>
      <Text dimColor>  Enter = allow · Esc = deny</Text>
    </Box>
  );
}
