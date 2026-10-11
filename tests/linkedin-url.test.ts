import { describe, expect, it } from "vitest";
import {
  absoluteLinkedinUrl,
  canonicalLinkedinUrl,
  inviteUrl,
  isAuthWallUrl,
  profileKey,
  profileVanity,
  vanityKey,
} from "@/lib/linkedin/url";

describe("profile URLs as they are actually stored", () => {
  // Every shape below is one that production contacts are stored in (identifiers changed).
  const stored: Array<[string, string]> = [
    ["http://www.linkedin.com/in/samcarter1", "samcarter1"],
    ["https://linkedin.com/in/priyanair1", "priyanair1"],
    ["https://ca.linkedin.com/in/noor-haddad", "noor-haddad"],
    ["https://www.linkedin.com/in/dana-cole-4b675293/", "dana-cole-4b675293"],
    ["https://www.linkedin.com/in/alexmorgan", "alexmorgan"],
  ];

  it.each(stored)("%s navigates to the canonical profile", (raw, vanity) => {
    expect(canonicalLinkedinUrl(raw)).toBe(`https://www.linkedin.com/in/${vanity}/`);
    expect(profileVanity(raw)).toBe(vanity);
  });

  it("accepts a value with no scheme, which page.goto would reject outright", () => {
    expect(canonicalLinkedinUrl("linkedin.com/in/jane-doe")).toBe("https://www.linkedin.com/in/jane-doe/");
    expect(canonicalLinkedinUrl("  www.linkedin.com/in/jane-doe/  ")).toBe("https://www.linkedin.com/in/jane-doe/");
  });

  it("drops tracking parameters and sub-pages from a profile URL", () => {
    expect(canonicalLinkedinUrl("https://www.linkedin.com/in/jane-doe/?utm_source=share&miniProfileUrn=x"))
      .toBe("https://www.linkedin.com/in/jane-doe/");
    expect(canonicalLinkedinUrl("https://www.linkedin.com/in/jane-doe/overlay/contact-info/"))
      .toBe("https://www.linkedin.com/in/jane-doe/");
    expect(canonicalLinkedinUrl("https://m.linkedin.com/in/jane-doe#experience"))
      .toBe("https://www.linkedin.com/in/jane-doe/");
  });

  it("keeps the case of an opaque profile id, which is case-sensitive", () => {
    const id = "ACoAABexampleProfileId-0000000000_sample";
    expect(profileVanity(`https://www.linkedin.com/in/${id}`)).toBe(id);
    expect(canonicalLinkedinUrl(`https://www.linkedin.com/in/${id}`)).toBe(`https://www.linkedin.com/in/${id}/`);
  });

  it("only normalises scheme and host on Sales Navigator URLs", () => {
    expect(canonicalLinkedinUrl("http://linkedin.com/sales/lead/ACwAAEIY,NAME_SEARCH,22wq?_ntb=abc"))
      .toBe("https://www.linkedin.com/sales/lead/ACwAAEIY,NAME_SEARCH,22wq?_ntb=abc");
    expect(profileVanity("https://www.linkedin.com/sales/lead/ACwAAEIY,NAME_SEARCH,22wq")).toBeNull();
  });

  it("returns non-LinkedIn and unparseable input untouched", () => {
    expect(canonicalLinkedinUrl("https://example.com/in/jane")).toBe("https://example.com/in/jane");
    expect(canonicalLinkedinUrl("not a url")).toBe("not a url");
    expect(canonicalLinkedinUrl("https://notlinkedin.com/in/jane")).toBe("https://notlinkedin.com/in/jane");
    expect(profileVanity("https://example.com/in/jane")).toBeNull();
    expect(profileVanity(null)).toBeNull();
    expect(profileVanity("")).toBeNull();
  });
});

describe("matching a stored URL to a LinkedIn public identifier", () => {
  it("matches regardless of host, scheme, trailing slash or case", () => {
    const key = vanityKey("SamCarter1");
    for (const raw of [
      "http://www.linkedin.com/in/samcarter1",
      "https://linkedin.com/in/samcarter1/",
      "https://www.linkedin.com/in/SamCarter1?trk=x",
      "linkedin.com/in/samcarter1",
    ]) {
      expect(profileKey(raw)).toBe(key);
    }
  });

  it("does not match a longer identifier that merely starts the same", () => {
    expect(profileKey("https://www.linkedin.com/in/jane-doe-12345/")).not.toBe(vanityKey("jane-doe"));
  });

  it("matches a non-ASCII identifier whether or not the stored URL is percent-encoded", () => {
    // LinkedIn's API returns identifiers like this verbatim, registered-trademark sign included.
    const fromApi = "sam-rivera-gphr®-3b2403146";
    expect(profileKey("https://www.linkedin.com/in/sam-rivera-gphr%C2%AE-3b2403146/")).toBe(vanityKey(fromApi));
    expect(profileKey(`https://www.linkedin.com/in/${fromApi}`)).toBe(vanityKey(fromApi));
    expect(canonicalLinkedinUrl(`https://www.linkedin.com/in/${fromApi}`))
      .toBe("https://www.linkedin.com/in/sam-rivera-gphr%C2%AE-3b2403146/");
  });

  it("survives a malformed percent-escape instead of throwing mid-sync", () => {
    expect(() => profileKey("https://www.linkedin.com/in/bad%E0%A4%A")).not.toThrow();
    expect(profileKey("https://www.linkedin.com/in/bad%E0%A4%A")).toBe("bad%e0%a4%a");
  });
});

describe("LinkedIn's own links", () => {
  it("builds the invitation URL LinkedIn's Connect link uses", () => {
    expect(inviteUrl("jordan-reyes")).toBe("https://www.linkedin.com/preload/custom-invite/?vanityName=jordan-reyes");
  });

  it("resolves root-relative hrefs read off the page", () => {
    expect(absoluteLinkedinUrl("/preload/custom-invite/?vanityName=x")).toBe("https://www.linkedin.com/preload/custom-invite/?vanityName=x");
    expect(absoluteLinkedinUrl("https://www.linkedin.com/in/x/")).toBe("https://www.linkedin.com/in/x/");
  });
});

describe("recognising a signed-out session", () => {
  it.each([
    "https://www.linkedin.com/login/?session_redirect=https%3A%2F%2Fwww.linkedin.com%2Ffeed%2F",
    "https://www.linkedin.com/authwall?trk=bf&sessionRedirect=x",
    "https://www.linkedin.com/checkpoint/challenge/AgF",
    "https://www.linkedin.com/uas/login",
    "https://www.linkedin.com/signup/cold-join",
  ])("%s is a wall", (url) => {
    expect(isAuthWallUrl(url)).toBe(true);
  });

  it.each([
    "https://www.linkedin.com/feed/",
    "https://www.linkedin.com/in/login-smith/",
    "https://www.linkedin.com/mynetwork/invite-connect/connections/",
    "https://www.linkedin.com/messaging/thread/2-abc==/",
    "about:blank",
  ])("%s is not a wall", (url) => {
    expect(isAuthWallUrl(url)).toBe(false);
  });
});
