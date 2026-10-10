import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link rel="icon" type="image/svg+xml" href="/logo_linki.svg" />
        <link rel="alternate icon" type="image/x-icon" href="/logo_linki.ico" />
        <link rel="apple-touch-icon" href="/logo_linki.png" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
