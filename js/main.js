// http://stackoverflow.com/a/8024509/1848454
window.onload = function () {
    var codeBlocks = document.querySelectorAll('div.highlight');
    codeBlocks.forEach(function (el) {
        el.addEventListener("dblclick", function () {
            if (window.getSelection && document.createRange) {
                // IE 9 and non-IE
                var range = document.createRange();
                range.selectNodeContents(el);
                var sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            } else if (document.body.createTextRange) {
                // IE < 9
                var textRange = document.body.createTextRange();
                textRange.moveToElementText(el);
                textRange.select();
            }
            document.execCommand("copy");
        });
    });
};
