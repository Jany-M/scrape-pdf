import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import type { Browser, Page } from "playwright";
import type { LimitFunction } from "./limiter";
import { ICLIArguments } from './scrape_pdf';

export type UrlSet = Set<string>;
export type ProcessQueue = Record<string, Promise<void>>;

// https://github.com/microsoft/playwright/blob/591e4ea9763bb1a81ecf289cc497292917f506ee/packages/playwright-core/src/server/page.ts#L414
type Media = undefined | null | "screen" | "print";
type ColorScheme = undefined | null | "light" | "dark" | "no-preference"

export const OUTPUT_DIR = "./output";

const handleCookieDialog = async (page: Page) => {
    // Common selectors for cookie acceptance buttons/elements
    const cookieSelectors = [
        // Generic accept buttons
        'button[id*="accept" i]',
        'button[class*="accept" i]',
        'a[id*="accept" i]',
        'a[class*="accept" i]',
        // Common cookie banner buttons
        '[aria-label*="accept" i]',
        '[data-testid*="accept" i]',
        // Common text-based buttons
        'button:has-text("Accept")',
        'button:has-text("Accept all")',
        'button:has-text("I accept")',
        'button:has-text("Allow all")',
        'button:has-text("Allow cookies")',
        // Common elements with German text
        'button:has-text("Akzeptieren")',
        'button:has-text("Alle akzeptieren")',
        // Common elements with French text
        'button:has-text("Accepter")',
        'button:has-text("J\'accepte")',
    ];

    for (const selector of cookieSelectors) {
        try {
            const button = await page.$(selector);
            if (button) {
                await button.click();
                // Wait a bit for any animations/transitions
                await page.waitForTimeout(500);
                return true;
            }
        } catch (e) {
            // Ignore errors and continue trying other selectors
        }
    }
    return false;
};

const visitPage = async (rootUrl: string, browser: Browser, url: string, verbose: boolean, dryRun: boolean, withHeader: boolean, media: string, colorScheme: string, skipExist: boolean, exclude?: string[]) => {
    const page = await browser.newPage();

    if (verbose) {
        console.log(chalk.yellow(`Navigating to ${url}`));
    }

    // Some websites will load initial content super quick but then take a while on CSS and assets, so lets wait until network idle
    try {
        await page.goto(url, { waitUntil: 'networkidle' });
        
        if (verbose) {
            console.log(chalk.yellow(`Page loaded, checking for cookie dialog`));
        }

        // Try to handle any cookie dialog
        const handled = await handleCookieDialog(page);
        if (handled) {
            if (verbose) {
                console.log(chalk.cyan(`Handled cookie dialog for ${url}`));
            }
        } else if (verbose) {
            console.log(chalk.yellow(`No cookie dialog found or couldn't handle it for ${url}`));
        }

    } catch (e) {
        console.log(chalk.red(`Error navigating to ${url}:\n${e}`));
        return [];
    }

    const newUrls = await getCleanUrlsFromPage(rootUrl, page, verbose, exclude);

    if (!dryRun) {
        await savePdfFile(page, url, verbose, withHeader, media, colorScheme, skipExist);
    }

    await page.close();

    // Remove duplicates
    return new Set(newUrls).keys();
}

const IGNORE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".svg", ".css", ".js", ".ico", ".xml", ".json", ".txt", ".md", ".pdf", ".zip"];
const getCleanUrlsFromPage = async (rootUrl: string, page: Page, verbose: boolean, exclude?: string[]) => {
    if (verbose) {
        console.log(chalk.yellow(`Extracting links from page: ${page.url()}`));
    }

    const allHrefElements = await page.locator('[href]').all();
    if (verbose) {
        console.log(chalk.yellow(`Found ${allHrefElements.length} total links`));
    }

    const hrefs: string[] = [];
    await Promise.all(
        allHrefElements.map(async locator => {
            const href = await locator.getAttribute('href');
            href && hrefs.push(href.split('#')[0]);
        })
    );

    if (verbose) {
        console.log(chalk.yellow(`Processed ${hrefs.length} valid href attributes`));
    }

    // Clean up URLs with inconsistent slashes
    const baseUrl = new URL(rootUrl);
    const pageUrl = new URL(page.url());
    const cleanUrls = hrefs.reduce((acc: string[], href) => {
        let url: string;
        try {
            // Handle different URL formats
            if (href.startsWith("http")) {
                url = href.trim();
            } else if (href.startsWith("/")) {
                // Absolute path
                url = new URL(href.trim(), baseUrl.origin).href;
            } else if (href && !href.startsWith("#") && !href.startsWith("mailto:")) {
                // Relative path - combine with current page path
                const currentPath = pageUrl.pathname;
                const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/') + 1);
                url = new URL(href.trim(), `${baseUrl.origin}${parentPath}`).href;
            } else {
                if (verbose) {
                    console.log(chalk.gray(`Skipping invalid URL format: ${href}`));
                }
                return acc;
            }

            // Remove empty URLs and self-references
            if (url === "" || url === "/" || url === baseUrl.href || url === baseUrl.origin + "/") {
                if (verbose) {
                    console.log(chalk.gray(`Skipping empty URL: ${url}`));
                }
                return acc;
            }

            // Remove URLs that aren't HTML pages
            if (IGNORE_EXTENSIONS.includes(path.extname(url))) {
                if (verbose) {
                    console.log(chalk.gray(`Skipping non-HTML extension: ${url}`));
                }
                return acc;
            }

            // Only include URLs that are on the same domain
            const urlObj = new URL(url);
            if (urlObj.origin === baseUrl.origin) {
                // Exclude URLs containing any of the exclude substrings
                if (exclude && exclude.some(substr => url.includes(substr))) {
                    if (verbose) {
                        console.log(chalk.gray(`Excluding URL due to match: ${url}`));
                    }
                    return acc;
                }
                if (verbose) {
                    console.log(chalk.blue(`Found valid URL: ${url}`));
                }
                acc.push(url);
            } else {
                if (verbose) {
                    console.log(chalk.gray(`Skipping external URL: ${url}`));
                }
            }
        } catch (e) {
            if (verbose) {
                console.log(chalk.red(`Error processing URL ${href}: ${e}`));
            }
        }
        return acc;
    }, []);

    if (verbose) {
        console.log(chalk.green(`Found ${cleanUrls.length} valid internal URLs to process`));
    }

    return cleanUrls;
}

const savePdfFile = async (page: Page, url: string, verbose: boolean, withHeader: boolean, media: string, colorScheme: string, skipExist: boolean) => {
    const lastSlashIndex = nthIndexOf(url, "/", 3);

    let pageTitle = await page.title()
    pageTitle = pageTitle.replace(/[^a-zA-Z0-9_]/g, "_");
    pageTitle = pageTitle.replace(/_{2,}/g, "_");

    let safeUrl = url.slice(lastSlashIndex + 1);
    safeUrl = safeUrl.replace(/[^a-zA-Z0-9_]/g, "_");
    safeUrl = safeUrl.replace(/_{2,}/g, "_");

    const fileName = `${pageTitle}_${safeUrl}.pdf`;
    const pdfPath = `${OUTPUT_DIR}/${fileName}`;

    // Check if file exists and skip if requested
    if (skipExist) {
        try {
            await fs.access(pdfPath);
            if (verbose) {
                console.log(chalk.yellow(`Skipping existing PDF: ${pdfPath}`));
            }
            return;
        } catch {
            // File doesn't exist, continue with PDF generation
        }
    }

    // https://playwright.dev/docs/api/class-page#page-emulate-media
    await page.emulateMedia({ media: media as Media, colorScheme: colorScheme as ColorScheme });

    // TODO: Headers are kinda broken, figure out CSS and page margin
    const headerTemplate = `
    <span style="font-size: 10px" class="date"></span>
    <span style="font-size: 10px"> | </span>
    <span style="font-size: 10px" class="title"></span>
    `
    const footerTemplate = `
    <span style="font-size: 10px" class="url"></span>
    <span style="font-size: 10px"> | </span>
    <span style="font-size: 10px" class="pageNumber"></span>
    <span style="font-size: 10px">/</span>
    <span style="font-size: 10px" class="totalPages"></span>
    `

    // https://playwright.dev/docs/api/class-page#page-pdf
    try {
        await page.pdf({ path: `${pdfPath}`, displayHeaderFooter: withHeader, headerTemplate, footerTemplate});
        if(verbose) {
            console.log(chalk.cyan(`PDF: ${pdfPath}`));
        }
    } catch (e) {
        console.log(chalk.red(`Error saving PDF: ${pdfPath}\n${e}`));
    }
}

const nthIndexOf = (string: string, char: string, nth: number, fromIndex: number = 0): number => {
    let indexChar = string.indexOf(char, fromIndex);
    if (indexChar === -1) {
        return -1;
    } else if (nth === 1) {
        return indexChar;
    } else {
        return nthIndexOf(string, char, nth - 1, indexChar + 1);
    }
}

export const processUrl = async (
    browser: Browser,
    rootUrl: string,
    url: string,
    visitedUrls: UrlSet,
    processQueue: ProcessQueue,
    args: Omit<ICLIArguments, 'rootUrl'>,
    limit: LimitFunction,
) => {
    if (visitedUrls.has(url)) {
        return;
    }
    if (args.verbose) {
        console.log(chalk.green(`URL: ${url}`), chalk.cyan(`(visited: ${visitedUrls.size}, remaining: ${Object.keys(processQueue).length})`));
    } else {
        console.log(chalk.green(`URL: ${url}`));
    }
    visitedUrls.add(url);
    const newUrls = await visitPage(rootUrl, browser, url, args.verbose, args.dryRun, args.withHeader, args.media, args.colorScheme, args.skipExist, args.exclude);
    for (const nextUrl of newUrls) {
        if (!visitedUrls.has(nextUrl)) {
            processQueue[nextUrl] = limit(() => processUrl(browser, rootUrl, nextUrl, visitedUrls, processQueue, args, limit));
        }
    };
    
    delete processQueue[url];
};
