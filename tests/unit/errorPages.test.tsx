import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ErrorPage from "@/app/error";
import GlobalError from "@/app/global-error";

// N10 Task 2 (AC-1003): the error pages show fixed text. Nothing of the error reaches the visitor except Next.js's digest,
// a short reference they can quote, and only when it looks like one.

const SECRET = ["zq7vK2mX", "p9Lw4Tn8", "Bc3Yd6Rh"].join("");
const text = (markup: string) => markup.replace(/<[^>]+>/g, "");
const retry = vi.fn();

describe("the error page", () => {
  it("shows fixed text and a retry button, and nothing from the error", () => {
    const markup = renderToStaticMarkup(<ErrorPage error={new Error(`password is ${SECRET}`)} retry={retry} />);
    expect(text(markup)).toMatch(/something went wrong/i);
    expect(markup).toMatch(/<button/);
    expect(markup).not.toContain(SECRET);
  });

  it("shows the digest as a reference when it looks like one", () => {
    const error = Object.assign(new Error("x"), { digest: "1234567890" });
    expect(text(renderToStaticMarkup(<ErrorPage error={error} retry={retry} />))).toContain("1234567890");
  });

  it("does not show a digest that does not look like one", () => {
    const error = Object.assign(new Error("x"), { digest: `see ${SECRET}!` });
    expect(renderToStaticMarkup(<ErrorPage error={error} retry={retry} />)).not.toContain(SECRET);
  });

  it("copes with something that is not an Error at all", () => {
    expect(() => renderToStaticMarkup(<ErrorPage error={SECRET} retry={retry} />)).not.toThrow();
    expect(renderToStaticMarkup(<ErrorPage error={SECRET} retry={retry} />)).not.toContain(SECRET);
  });
});

describe("the global error page", () => {
  it("is a whole document with fixed text", () => {
    const markup = renderToStaticMarkup(<GlobalError error={new Error(SECRET)} retry={retry} />);
    expect(markup).toMatch(/<html/);
    expect(markup).toMatch(/<body/);
    expect(text(markup)).toMatch(/something went wrong/i);
    expect(markup).not.toContain(SECRET);
  });
});
