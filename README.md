# ScanCode LicenseDB diff browser extension (not official)

This browser extension diffs selected text to find the closest matches. This compares against the 
ScanCode LicenseDB list: https://scancode-licensedb.aboutcode.org/index.html.

This project was created to help me with comparing licenses easily from a browser. This is not an
official extension.

## Installation

The extension is available to install from the Chrome Web Store. You will need to use the link
below since the extension is currently unlisted.
https://chromewebstore.google.com/detail/licensedb-diff/nlbgoabjahcideocgmnipmeabicnpejf

## Using the extension

To run the diff, select text on a web page and click on the extension icon. Once the comparisons have
completed, it will return the top 10 results. You can select each result from the dropdown to see the
differences and copy the license identifier by clicking on the copy button.

If the license has a [SPDX identifier](https://spdx.org/licenses/), that will be displayed instead of
the ScanCode LicenseRef (LicenseRef-scancode-*).

Licenses and exceptions that are marked with `"is_deprecated": true` are currently excluded from comparison
but I would like to add the ability to include/exclude as an option in the future.

This has only been tested to diff text on web pages and may not work correctly for documents being
viewed in a browser.
