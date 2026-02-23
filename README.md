# LicenseDB License diff browser extension (not official)

The LicenseDB License Diff browser extension diffs selected text to find the closest license or 
exception text matches against AboutCode's [ScanCode LicenseDB list](https://scancode-licensedb.aboutcode.org/index.html) and the [SPDX License List](https://spdx.org/licenses/).
These lists include identifiers, license text and exception text from AboutCode, SPDX and OSI.

This project was created to help me with comparing licenses easily from a browser. This is not an
official extension.

## Installation

The extension is available for
[Chrome](https://chromewebstore.google.com/detail/licensedb-diff/nlbgoabjahcideocgmnipmeabicnpejf)
and [Microsoft Edge](https://microsoftedge.microsoft.com/addons/detail/licensedb-diff/phmkmmgkfediamaidpmmdgnbbglchadl).

## Using the extension

To run the diff, select text on a web page and click on the extension icon. You will have the option
to compare against licenses, exceptions or both. Once the comparisons have
completed, it will return the top 20 results (this can be changed in the extension options). You can
select each result from the dropdown to see the differences and copy the license identifier by clicking
on the copy button.

Licenses and exceptions that are marked as deprecated are currently excluded from comparison
but I would like to add the ability to include/exclude as an option in the future.

This has only been tested to diff text on web pages and may not work correctly for documents being
viewed in a browser.
