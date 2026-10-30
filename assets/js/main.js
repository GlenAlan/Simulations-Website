/*
	Phantom by HTML5 UP
	html5up.net | @ajlkn
	Free for personal and commercial use under the CCA 3.0 license (html5up.net/license)
*/

(function($) {

	var	$window = $(window),
		$body = $('body'), // Keep $body for other uses if any
		$html = $('html'); // Add $html for theme management

	// Breakpoints.
		breakpoints({
			xlarge:   [ '1281px',  '1680px' ],
			large:    [ '981px',   '1280px' ],
			medium:   [ '737px',   '980px'  ],
			small:    [ '481px',   '736px'  ],
			xsmall:   [ '361px',   '480px'  ],
			xxsmall:  [ null,      '360px'  ]
		});

	// Play initial animations on page load.
		$window.on('load', function() {
			window.setTimeout(function() {
				$body.removeClass('is-preload');
			}, 100);
		});

	// Touch?
		if (browser.mobile)
			$body.addClass('is-touch'); // This can stay on $body if specific touch styles target body.is-touch

	// Forms.
		var $form = $('form');

		// Auto-resizing textareas.
			$form.find('textarea').each(function() {

				var $this = $(this),
					$wrapper = $('<div class="textarea-wrapper"></div>'),
					$submits = $this.find('input[type="submit"]');

				$this
					.wrap($wrapper)
					.attr('rows', 1)
					.css('overflow', 'hidden')
					.css('resize', 'none')
					.on('keydown', function(event) {

						if (event.keyCode == 13
						&&	event.ctrlKey) {

							event.preventDefault();
							event.stopPropagation();

							$(this).blur();

						}

					})
					.on('blur focus', function() {
						$this.val($.trim($this.val()));
					})
					.on('input blur focus --init', function() {

						$wrapper
							.css('height', $this.height());

						$this
							.css('height', 'auto')
							.css('height', $this.prop('scrollHeight') + 'px');

					})
					.on('keyup', function(event) {

						if (event.keyCode == 9)
							$this
								.select();

					})
					.triggerHandler('--init');

				// Fix.
					if (browser.name == 'ie'
					||	browser.mobile)
						$this
							.css('max-height', '10em')
							.css('overflow-y', 'auto');

			});

	// Theme Toggle.
		var $themeToggleButton = $('#theme-toggle');

		if ($themeToggleButton.length) {
			var $sunIcon = $themeToggleButton.find('.fa-sun');
			var $moonIcon = $themeToggleButton.find('.fa-moon');
			var scrollThreshold = 50; // Hide when scrolled more than 50px

			function checkScrollAndToggleThemeButton() {
				var scrollTop = $window.scrollTop(); 

				if (scrollTop > scrollThreshold) {
					if (!$themeToggleButton.hasClass('is-hidden-on-scroll')) {
						$themeToggleButton.addClass('is-hidden-on-scroll');
					}
				} else {
					if ($themeToggleButton.hasClass('is-hidden-on-scroll')) {
						$themeToggleButton.removeClass('is-hidden-on-scroll');
					}
				}
			}

			$window.on('scroll.themeToggleHide', checkScrollAndToggleThemeButton);
			checkScrollAndToggleThemeButton();

			if (!$sunIcon.length || !$moonIcon.length) {
				console.error('Theme icons not found in toggle button');
			} else {
				function getCurrentTheme() {
					let theme = window.localStorage.getItem('theme');
					// Only respect 'light' as a valid stored value, otherwise force dark
					if (theme === 'light') {
						return 'light';
					}
					return 'dark'; // Always default to dark mode, ignoring system preferences
				}

				function loadTheme(theme) {
					$html.removeClass('light-mode dark-mode').addClass(theme + '-mode');

					if (theme === 'dark') {
						$sunIcon.hide();
						$moonIcon.css('display', 'inline-block'); 
						$themeToggleButton.attr('title', 'Switch to light mode');
						var $moonLabel = $moonIcon.find('.label');
						if ($moonLabel.length) $moonLabel.text('Light Mode');
					} else {
						$sunIcon.css('display', 'inline-block'); 
						$moonIcon.hide();
						$themeToggleButton.attr('title', 'Switch to dark mode');
						var $sunLabel = $sunIcon.find('.label');
						if ($sunLabel.length) $sunLabel.text('Dark Mode');
					}
				}

				$themeToggleButton.on('click', function() {
					let currentTheme = $html.hasClass('dark-mode') ? 'dark' : 'light';
					let newTheme = currentTheme === 'dark' ? 'light' : 'dark';
					window.localStorage.setItem('theme', newTheme);
					loadTheme(newTheme);
				});

				loadTheme(getCurrentTheme());
			}
		}


	// Menu.
		var $menu = $('#menu');

		$menu.wrapInner('<div class="inner"></div>');

		$menu._locked = false;

		$menu._lock = function() {

			if ($menu._locked)
				return false;

			$menu._locked = true;

			window.setTimeout(function() {
				$menu._locked = false;
			}, 350);

			return true;

		};

		$menu._show = function() {

			if ($menu._lock())
				$body.addClass('is-menu-visible'); // This class controls menu visibility, can stay on body

		};

		$menu._hide = function() {

			if ($menu._lock())
				$body.removeClass('is-menu-visible'); // This class controls menu visibility, can stay on body

		};

		$menu._toggle = function() {

			if ($menu._lock())
				$body.toggleClass('is-menu-visible'); // This class controls menu visibility, can stay on body

		};

		$menu
			.appendTo($body)
			.on('click', function(event) {
				event.stopPropagation();
			})
			.on('click', 'a', function(event) {

				var href = $(this).attr('href');

				event.preventDefault();
				event.stopPropagation();

				// Hide.
					$menu._hide();

				// Redirect.
					if (href == '#menu')
						return;

					window.setTimeout(function() {
						window.location.href = href;
					}, 350);

			})
			.append('<a class="close" href="#menu">Close</a>');

		$body
			.on('click', 'a[href="#menu"]', function(event) {

				event.stopPropagation();
				event.preventDefault();

				// Toggle.
					$menu._toggle();

			})
			.on('click', function(event) {

				// Hide.
					$menu._hide();

			})
			.on('keydown', function(event) {

				// Hide on escape.
					if (event.keyCode == 27)
						$menu._hide();

			});

})(jQuery);