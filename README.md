# ScanCode LicenseDB diff browser extension (not official)

This browser extension diffs selected text to find the closest matches. This compares against the 
ScanCode LicenseDB list: https://scancode-licensedb.aboutcode.org/index.html.

This project was created to help me with comparing licenses easily from a browser. This is not an
official extension.

## Installation

Thsi exetnsion has only been tested in Chrome. I would like to test other browsers in the future.

To run this extension in your browser, you will need to clone the repo locally and follow the steps to
load an unpacked extension.
https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked

## Using the extension

To run the diff, select text on a web page and click on the extension icon. Once the comparisons have
completed, it will return the top 10 results. You can select each result from the dropdown to see the
differences and copy the license identifier by clicking on the copy button.

If the license has a [SPDX identifier](https://spdx.org/licenses/), that will be displayed instead of
the ScanCode LicenseRef (LicenseRef-scancode-*).

Deprecated licenses and exceptions are currently excluded but I would like to add the ability to 
include/exclude as an option in the future.

This has only been tested to diff text on web pages and will may not work correctly for documents being
viewed in a browser.
