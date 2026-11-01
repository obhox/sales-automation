import {describe, expect, it} from "vitest";
import {createTranslator} from "next-intl";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import en from "../messages/en.json";
import pt from "../messages/pt-BR.json";

const br = createTranslator({locale: "pt-BR", messages: pt});
const english = createTranslator({locale: "en", messages: en});
const sections = ["TeamInvite","TeamMembers","TeamSideCards","TeamAudit","ShellApp","ShellSearch","ShellHelp","ShellNotifications","ShellWorkspace"] as const;

describe("team permissions and navigation i18n pt-BR / en", () => {
  it("has exactly matching keys in both catalogs", () => {
    for (const section of sections) expect(Object.keys(pt[section]).sort()).toEqual(Object.keys(en[section]).sort());
  });

  it("localizes invitation validation, sharing and role descriptions", () => {
    expect(br("TeamInvite.invalidEmail")).toContain("e-mail");
    expect(br("TeamInvite.workspace", {name:"Agência Alfa"})).toContain("Agência Alfa");
    expect(br("TeamInvite.emailSent", {email:"contato@empresa.com"})).toContain("contato@empresa.com");
    expect(br("TeamInvite.summaryManager")).toContain("campanhas");
    expect(english("TeamInvite.send")).toBe("Send invitation");
  });

  it("localizes member role changes and access safeguards", () => {
    expect(br("TeamMembers.makeOwnerTitle", {name:"Ana"})).toContain("Ana");
    expect(br("TeamMembers.roleChanged", {name:"Ana", role:"Gerente"})).toContain("Gerente");
    expect(br("TeamMembers.suspendBody")).toContain("MCP");
    expect(br("TeamMembers.activeKeys", {count:2})).toContain("2 chaves");
    expect(br("TeamMembers.memberRemoved", {name:"Ana"})).toContain("Ana");
    expect(english("TeamMembers.roleOwner")).toBe("Owner");
  });

  it("localizes invitation renewal and audit labels", () => {
    expect(br("TeamMembers.sentAgain", {email:"ana@empresa.com", clipboard:""})).toContain("ana@empresa.com");
    expect(br("TeamMembers.revokeTitle", {email:"ana@empresa.com"})).toContain("revogar".replace(/^./, "R"));
    expect(br("TeamAudit.changedRole", {name:"Ana"})).toContain("Ana");
    expect(br("TeamAudit.retention", {count:12})).toContain("12 meses");
    expect(br("TeamAudit.entriesCount", {count:1500})).toContain("1.500");
  });

  it("localizes workspace management and capability matrix", () => {
    expect(br("TeamSideCards.memberSummary", {count:1, role:"Gerente"})).toContain("1 membro");
    expect(br("TeamSideCards.memberSummary", {count:5, role:"Gerente"})).toContain("5 membros");
    expect(br("TeamSideCards.capMembers")).toContain("Convidar");
    expect(br("TeamSideCards.permissionNote")).toContain("API");
  });

  it("localizes shell navigation and global search", () => {
    expect(br("ShellApp.openNavigation")).toBe("Abrir navegação");
    expect(br("ShellSearch.noMatches", {query:"xyz"})).toContain("xyz");
    expect(br("ShellSearch.searchPlaceholder")).toContain("contatos");
    expect(br("ShellHelp.tourOf", {name:"Campanhas"})).toContain("Campanhas");
    expect(br("ShellHelp.tour_team")).toBe("Equipe e perfis");
    expect(br("ShellHelp.tour_csv_import")).toBe("Importação CSV");
    expect(br("ShellWorkspace.workspaceLabel", {name:"Alfa"})).toContain("Alfa");
    expect(english("ShellSearch.title")).toBe("Search and jump");
  });

  it("localizes unread notifications and empty states", () => {
    expect(br("ShellNotifications.unreadCount", {count:1})).toContain("1 não lida");
    expect(br("ShellNotifications.unreadCount", {count:3})).toContain("3 não lidas");
    expect(br("ShellNotifications.emptyHint")).toContain("importações");
  });

  it("keeps operational RBAC role identifiers and API routes unchanged", () => {
    const files = ["team/InviteDialog.tsx","team/MembersCard.tsx","team/SideCards.tsx","shell/WorkspaceSwitcher.tsx"];
    const joined = files.map(f => readFileSync(join(process.cwd(), "components", f), "utf8")).join("\n");
    expect(joined).toContain('useState<WorkspaceRole>("member")');
    expect(joined).toContain('"/api/platform/members"');
    expect(joined).toContain('"/api/platform/invitations"');
    expect(joined).toContain('"/api/platform/workspaces"');
    expect(joined).toContain("grantableRoles");
  });
});
