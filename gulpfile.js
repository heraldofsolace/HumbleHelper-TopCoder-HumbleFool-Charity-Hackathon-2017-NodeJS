const gulp = require('gulp');
const newer = require('gulp-newer');
const imagemin = require('gulp-imagemin');
const htmlclean = require('gulp-htmlclean');
const replace = require('gulp-replace');
const sass = require('gulp-sass');
const assets = require('postcss-assets');
const uglify = require('gulp-uglify');
const autoprefixer = require('autoprefixer');
const postcss = require('gulp-postcss');
const fs = require('fs');
const path  = require('path');
const cssnano = require('cssnano');
const stripdebug = require('gulp-strip-debug');
const uglifier = require('uglify-es');
const composer = require('gulp-uglify/composer');
const folders = {
    src: 'src/',
    build: 'build/'
};

gulp.task('images', function() {
    return gulp.src([folders.src + 'resources/images/*',folders.src + 'resources/icons/**/*'])
        .pipe(newer(folders.build + 'images/'))
        .pipe(imagemin({ optimizationLevel: 5}))
        .pipe(gulp.dest(folders.build + 'images/'));
});

gulp.task('buildcss', ['images'], function() {
    const postcssoptions = [
        // assets({ loadPaths: ['../resources/images/'], relative:true }),
        autoprefixer({ browsers: ['last 2 versions', '> 2%'] }),
        cssnano
    ];

    return gulp.src(folders.src + 'sass/*.scss').pipe(sass({
        imagePath: 'images/',
        errLogToConsole: true
    })).pipe(postcss(postcssoptions))
        .pipe(gulp.dest(folders.build + 'css/'));
});

gulp.task('copycss', ['buildcss'], function() {
    return gulp.src(folders.src + 'vendors/css/*.css')
        .pipe(postcss([cssnano])).pipe(gulp.dest(folders.build + 'css/'));
});

gulp.task('minifyjs', function() {
    return gulp.src([folders.src + 'resources/js/*.js',folders.src + 'vendors/js/*.js', folders.src + 'vendors/mode/**/*.js'])
        .pipe(stripdebug()).on('error', function(err) {
            console.log(err);
        })
        .pipe(composer(uglifier, console)()).on('error', function(err) {
            console.log(err);
        }).pipe(gulp.dest(folders.build + 'js/'));
});

gulp.task('replacejsandcss', ['minifyjs','copycss'], function() {
    return gulp.src(folders.src + 'templates/*.ejs')
        .pipe(replace(/<link rel="stylesheet" href="\/(resources|vendors)\/css\/(.*?)">/g, function(match, p1, p2) {
            return '<style>' + fs.readFileSync(path.join(folders.build, 'css', p2), 'utf8') + '</style>';
        }))
        .pipe(replace(/<script src="\/(resources|vendors)\/js\/(.*?)"><\/script>/g, function(match, p1, p2) {
            return '<script>' + fs.readFileSync(path.join(folders.build, 'js', p2), 'utf8') + '</script>';
        })).pipe(replace(/<script src="\/vendors\/mode\/(.*?)\/(.*?)"><\/script>/g, function(match, p1, p2) {
            return '<script>' + fs.readFileSync(path.join(folders.build, 'js', p1, p2), 'utf8') + '</script>';
        }))
        .pipe(htmlclean())
        .pipe(gulp.dest(folders.build + 'html'));
});

gulp.task('run', ['replacejsandcss']);
gulp.task('watch', function() {
    gulp.watch(folders.src + 'templates/*', ['replacejsandcss']);
    gulp.watch(folders.src + 'resources/images/*', ['images']);
    gulp.watch(folders.src + 'resources/js/*', ['replacejsandcss']);
    gulp.watch(folders.src + 'sass/*', ['replacejsandcss']);
});
gulp.task('default', ['run','watch']);
