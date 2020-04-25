var map = L.map('map', {'worldCopyJump': true}).setView([0,0], 2);

map.on('zoomend', function(e) {
    selected_marker = undefined;
    info.clear();
});

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}' + (L.Browser.retina ? '@2x.png' : '.png'), {
   attribution:'&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>, &copy; <a href="https://carto.com/attributions">CARTO</a>',
   subdomains: 'abcd',
   maxZoom: 20,
   minZoom: 0
}).addTo(map);

var info = L.control();

info.onAdd = function (map) {
    this._div = L.DomUtil.create('div', 'info');
    this.clear();
    return this._div;
};

info.update = function (confirmed, deaths, recoveries, active, placenames) {
    if(Array.isArray(placenames)) {
        var truncated = false;
        placenames = placenames.reduce(function (names_str,next) {
            var new_names_str = names_str + next + "; ";
            if (new_names_str.length <= 100){
                return new_names_str;
            } else {
                truncated = true;
                return names_str;
            }
        },"");
        if (truncated) {
            placenames = placenames + "etc.";
        } else {
            placenames = placenames.substring(0, placenames.length-2);
        }
    }
    this._div.innerHTML = (placenames != undefined ? "<b>" + placenames + "</b><br>" : "") +
               "Confirmed: " + confirmed + "</br>" +
               "Deaths: " + deaths  + "<br>" +
               "Recoveries:" + recoveries + "<br>" +
               "Active:" + active + "<br>";
    updateSidebarInfo(confirmed, deaths, recoveries, active, placenames);
};


function updateSidebarInfo(confirmed, deaths, recoveries, active, placenames) {
    document.getElementById("sidebar_confirmed").innerHTML = confirmed;
    document.getElementById("sidebar_deaths").innerHTML = deaths;
    document.getElementById("sidebar_recoveries").innerHTML = recoveries;
    document.getElementById("sidebar_active").innerHTML = active;
    document.getElementById("sidebar_location").innerHTML = placenames;
}

function clearSidebarInfo() {
    updateSidebarInfo("","","","","");
}

info.clear = function () {
    this._div.innerHTML = "Hover over or click marker";
    clearSidebarInfo();
}

info.updateForMarker = function(marker){
    if (selected_marker && selected_marker._icon) {
        selected_marker._icon.classList.remove('selected');
    } else if (selected_marker && selected_marker.layer._icon) {
        selected_marker.layer._icon.classList.remove('selected');
    }

    var confirmed, deaths, recoveries, active, names;
    if(marker.layer){
        confirmed = marker.layer.getAllChildMarkers().reduce((a,v) => a + v.confirmed, 0);
        deaths = marker.layer.getAllChildMarkers().reduce((a,v) => a + v.deaths, 0);
        recoveries = marker.layer.getAllChildMarkers().reduce((a,v) => a + v.recoveries, 0);
        active = marker.layer.getAllChildMarkers().reduce((a,v) => a + v.active, 0);
        names = marker.layer.getAllChildMarkers().slice().filter((e)=>e.confirmed>0).sort((a,b) => a.confirmed - b.confirmed).reverse().map((v) => v.name);
        marker.layer._icon.classList.add('selected');
    } else {
        confirmed = marker.confirmed;
        deaths = marker.deaths;
        recoveries = marker.recoveries;
        active = marker.active;
        names = marker.name;
        marker._icon.classList.add('selected');
    }
    info.update(confirmed, deaths, recoveries, active, names);

    selected_marker = marker;
}

info.addTo(map);

$( "#slider-range" ).slider({
  range: true,
  min: 0,
  max: 100,
  values: [ 0, 100 ],
  slide: function( event, ui ) {
    terminateAnimation();
    var displayStartMins = ui.values[0];
    var displayEndMins = ui.values[1];

    setDisplayedDateRange(displayStartMins, displayEndMins);

    animateWindow = displayEndMins - displayStartMins;
  }
});

var country_select = document.getElementById("country_select");
var sorted_options =  Object.entries(bounding_boxes).sort(function(a,b) { return a[1][0].localeCompare(b[1][0])});
for (var e of sorted_options) {
    var key = e[0];
    var label = e[1][0];
    var option = document.createElement("option");
    var textnode = document.createTextNode(label);
    option.appendChild(textnode);
    option.value = key;
    country_select.appendChild(option);
}

var dataStartDate;
var dataEndDate;
var displayStartDate;
var displayEndDate;

var animateWindow = 7 * 24 * 60;
var animateStep = 24 * 60;
var animateSpeed = 100;
var cumulativeAnimation = document.getElementById("cumulative_animation").checked;
document.getElementById("animate_window").disabled = cumulativeAnimation;

var animation_paused = false;

var selected_marker = undefined;

class NewsStandDataLayer {
    constructor(plottingLayer, color_fn, url_fn) {
        var that = this;
        this.markers = L.markerClusterGroup({
            chunkedLoading: true,
            chunkProgress: updateProgressBar,
            iconCreateFunction: function(cluster) {
                var childCount = cluster.getAllChildMarkers().reduce((a,v) => a + v.count, 0)
                return that.markerIcon(childCount);
            }
        });
        this.markers.on('spiderfied', function (a) {
            var allArticles = a.markers.flatMap( function (m) {return m.articles});
            L.popup({maxHeight: 200}).setLatLng(a.cluster.getLatLng()).setContent(that.makePopupHtml(allArticles, a.markers[0].name)).openOn(map);
        });
        map.addLayer(this.markers);

        this.plottingLayer = plottingLayer;
        this.color_fn = color_fn;
        this.url_fn = url_fn;
        this.markerList = [];
        this.node_list = [];

        this.display_start_date = undefined;
        this.display_end_Date = undefined;
    }

    togglePlotting() {
        this.plottingLayer = ! this.plottingLayer;

        if(this.plottingLayer){
            var startDate = displayStartDate;
            var endDate = displayEndDate;
            var subMarkerList = this.markersBetween(startDate, endDate);
            this.markers.clearLayers();
            this.markers.addLayers(subMarkerList);
        } else {
            this.markers.clearLayers();
        }
    }

    markersBetween(timeStart, timeEnd) {
        var iStart = nodeIndexOfTime(this.nodeList, timeStart)
        var iEnd = nodeIndexOfTime(this.nodeList, timeEnd)
        return this.markerList.slice(iStart, iEnd);
    }

    setMarkers(nodes) {
        this.markers.clearLayers();
        this.nodeList = nodes;
        var that = this;
        this.markerList = this.nodeList.map(function (p) {
            var marker = new L.Marker(L.latLng(p.lat, p.lng), { icon: that.markerIcon(p.count)});
            var articles;
            if (p.articles) {
                articles = JSON.parse(p.articles);
                articles = articles.map(function (a) {
                    return {title: a['f1'], url: a['f2']};
                });
            } else {
                articles = [];
            }
            marker.bindPopup(that.makePopupHtml(articles, p.name),{maxHeight: 100});
            marker.count = p.count;
            marker.name = p.name;
            marker.articles = articles;
            return marker;
        });
        if(this.plottingLayer){
          this.markers.addLayers(this.markerList);
        }
    }

    updateLayer() {
        terminateAnimation();
        var loader = document.getElementById('loader');
        loader.style.display = 'block';

        var url = this.url_fn();
        var xhr = new XMLHttpRequest();
        var that = this;
        xhr.open("GET", url, true);
        xhr.onload = function (e) {
          if (xhr.readyState === 4) {
            if (xhr.status === 200) {
              var nodes = JSON.parse(xhr.responseText);
              that.setMarkers(nodes);
            } else {
              console.error(xhr.statusText);
            }

            loader.style.display = 'none';
          }
        }
        xhr.send(null);
    }

    makePopupHtml(articles, name) {
        var articles_html = articles.map(function(e) {
          return "<li><a href=" + e.url +">" + e.title + "</a></li>";
        }).join("");
        return "<em>"+name+"</em><br><ol>"+articles_html+"</ol>";
    }

    markerIcon(clusterSize) {
        var size = markerSize(clusterSize);
        var color = this.color_fn(clusterSize);

        var elemStyle =
          'border-radius: 50%;' +
          'width: '  + size + 'px;' +
          'height: ' + size + 'px;' +
          'line-height: ' + size + 'px;' +
          'font-weight: bold;' +
          'background-color: ' + color + ';';

        return new L.DivIcon({ html: '<div style="' + elemStyle + '">' + clusterSize + '</div>', className: 'marker-cluster', iconSize: new L.Point(size, size) });
    }

    plotData(timeStart, timeEnd){
        if(this.plottingLayer){
            // Special handeling for incremental animation
            if(this.display_start_date == timeStart && timeEnd > this.display_end_date) {
                var subMarkerList = this.markersBetween(this.display_end_date, timeEnd);
                this.markers.addLayers(subMarkerList);
                this.display_end_date = timeEnd;
            } else {
                this.display_start_date = timeStart;
                this.display_end_date = timeEnd;
                var subMarkerList = this.markersBetween(timeStart, timeEnd);
                this.markers.clearLayers();
                this.markers.addLayers(subMarkerList);
            }
        }
    }

}

class JHUDataLayer {
    constructor(plottingConfirmed, plottingDeaths, plottingRecoveries, plottingActive) {
        this.timeSeries = jhuData;
        this.subLayers = {
            confirmed: { plotting: plottingConfirmed },
            deaths: { plotting: plottingDeaths },
            recoveries: { plotting: plottingRecoveries },
            active: {plotting:  plottingActive }
        };

        var that = this;
        this.markers = L.markerClusterGroup({
            chunkedLoading: true,
            showCoverageOnHover: false,
            zoomToBoundsOnClick: false,
            iconCreateFunction: function(cluster) {
                var confirmed = cluster.getAllChildMarkers().reduce((a,v) => a + v.confirmed, 0);
                var deaths = cluster.getAllChildMarkers().reduce((a,v) => a + v.deaths, 0);
                var recoveries = cluster.getAllChildMarkers().reduce((a,v) => a + v.recoveries, 0);
                var active = that.computeActive(confirmed, deaths, recoveries);
                return that.layerIcon(confirmed, deaths, recoveries, active);
            }
        });

        this.markers.on('clustermousedown', function (a) {
            info.updateForMarker(a);
        });
        this.timeSeriesMarkers = this.timeSeries.map(function (p) {
            var marker = L.marker([p.lat, p.lng]);
            marker.name = p.name;
            marker.time_series = p.time_series;
            marker.on('click', function(e) {
                info.updateForMarker(marker);
            });
            return marker;
        });

        this.markers.clearLayers();
        this.markers.addLayers(this.timeSeriesMarkers)
    }

    plottingAny() {
        return Object.values(this.subLayers).reduce(
            function (a,b) {
                return a || b.plotting;
            },
            false);
    }

    togglePlotting(subLayer) {
        if(!this.plottingAny()){
            map.addLayer(this.markers);
        }
        this.subLayers[subLayer].plotting = ! this.subLayers[subLayer].plotting;
        if(this.plottingAny()) {
            var startDate = displayStartDate;
            var endDate = displayEndDate;
            this.plotData(startDate, endDate);
        } else {
            map.removeLayer(this.markers);
        }
    }

    plotData(timeStart, timeEnd){
        if( this.plottingAny() ){
            for (var i = 0; i < this.timeSeriesMarkers.length; i++){
                var m = this.timeSeriesMarkers[i];
                var entryStart = m.time_series[nodeIndexOfTime(m.time_series, timeStart)]
                var entryEnd = m.time_series[nodeIndexOfTime(m.time_series, timeEnd)];

                var confirmed = entryEnd.confirmed - entryStart.confirmed;
                var deaths = entryEnd.deaths - entryStart.deaths;
                var recoveries = entryEnd.recovered - entryStart.recovered;
                var active = this.computeActive(confirmed, deaths, recoveries);

                var icon = this.layerIcon(confirmed, deaths, recoveries, active);
                m.setIcon(icon)

                m.confirmed = confirmed;
                m.deaths = deaths;
                m.recoveries = recoveries;
                m.active = active;
            }
            this.markers.refreshClusters();
        }
    }

    computeActive(confirmed, deaths, recoveries) {
        return confirmed - (deaths + recoveries);
    }

    layerIcon(confirmed, deaths, recovered, active) {
        var confirmedSize = markerSize(confirmed);
        var confirmedStyle =
          'position: relative;' +
          'font-weight: bolder;' +
          'border-radius: 50%;' +
          'line-height: '  + confirmedSize + 'px;' +
          'width: '  + confirmedSize + 'px;' +
          'height: ' + confirmedSize + 'px;';

        if(this.subLayers.confirmed.plotting) {
            confirmedStyle += 'border: dotted black ;';
        }

        var deathsSize = markerSize(deaths);
        var deathsStyle =
          'position: absolute;' +
          'border-radius: 50%;' +
          'top: 50%;' +
          'left: 50%;' +
          'margin: ' + (-deathsSize/2) +'px 0px 0px ' + (-deathsSize/2) + 'px;' +
          'width: '  + deathsSize + 'px;' +
          'height: ' + deathsSize + 'px;' +
          'border: dotted red ;';

        var recoveredSize = markerSize(recovered);
        var recoveredStyle =
          'position: absolute;' +
          'border-radius: 50%;' +
          'top: 50%;' +
          'left: 50%;' +
          'margin: ' + (-recoveredSize/2) +'px 0px 0px ' + (-recoveredSize/2) + 'px;' +
          'width: '  + recoveredSize + 'px;' +
          'height: ' + recoveredSize + 'px;' +
          'border: dotted green ;';

        var activeSize = markerSize(active);
        var activeStyle =
          'position: absolute;' +
          'border-radius: 50%;' +
          'top: 50%;' +
          'left: 50%;' +
          'margin: ' + (-activeSize/2) +'px 0px 0px ' + (-activeSize/2) + 'px;' +
          'width: '  + activeSize + 'px;' +
          'height: ' + activeSize + 'px;' +
          'border: dotted orange ;';

        if ((confirmed + deaths + recovered) == 0) {
            confirmedStyle += 'display: none;';
        }

        return new L.DivIcon({
            html: '<div class="circle" style="' + confirmedStyle + '">' +
                    (this.subLayers.deaths.plotting && deaths > 0 ? '<div class="circle" style="' + deathsStyle + '"></div>' : '') +
                    (this.subLayers.recoveries.plotting && recovered > 0 ? '<div class="circle" style="' + recoveredStyle + '"></div>' : '') +
                    (this.subLayers.active.plotting && active > 0 ? '<div class="circle" style="' + activeStyle + '"></div>' : '') +
                  '</div>',
            className: 'marker-cluster',
            iconSize: new L.Point(confirmedSize, confirmedSize)
        });
    }
}

var confirmedCasesSelected = document.getElementById("confirmed_cases_checkbox").checked;
var deathsSelected = document.getElementById("deaths_checkbox").checked;
var recoveredSelected = document.getElementById("recovered_checkbox").checked;
var activeSelected = document.getElementById("active_checkbox").checked;
var jhuLayer = new JHUDataLayer(confirmedCasesSelected, deathsSelected, recoveredSelected, activeSelected);

var newsDataSelected = document.getElementById("news_data_checkbox").checked;
var newsLayer = new NewsStandDataLayer(newsDataSelected,
    function(clusterSize){
        var color;
        if (clusterSize < 10) {
            color = 'rgba(181, 226, 140, 0.6)';
        } else if (clusterSize < 100) {
            color = 'rgba(241, 211, 87, 0.6)';
        } else {
            color = 'rgba(253, 156, 115, 0.6)';
        }
        return color;
    },
    function() {
        var keyword = document.getElementById('keyword').value;
        var start_date = new Date(document.getElementById('start_date').value);
        var end_date = new Date(document.getElementById('end_date').value);

        var start_epoch_mins = dateToEpochMins(start_date);
        var end_epoch_mins = dateToEpochMins(end_date) + (1000 * 60) - 1;

        var url = "https://newsstand.umiacs.umd.edu/coronaviz/disease_time_query" +
              "?keyword=" + keyword +
              "&start_date=" + start_epoch_mins +
              "&end_date=" + end_epoch_mins;

        return url;
    });

var twitterDataSelected = document.getElementById("twitter_data_checkbox").checked;
var twitterLayer = new NewsStandDataLayer(twitterDataSelected,
    function(clusterSize){
        return color = 'rgba(85, 85, 250, 0.6)';
    },
    function() {
      var start_date = new Date(document.getElementById('start_date').value);
      var end_date = new Date(document.getElementById('end_date').value);

      var start_epoch_mins = dateToEpochMins(start_date);
      var end_epoch_mins = dateToEpochMins(end_date) + (1000 * 60) - 1;

      var url = "https://newsstand.umiacs.umd.edu/coronaviz/twitter_query" +
            "?start_date=" + start_epoch_mins +
            "&end_date=" + end_epoch_mins;

      return url;
    });

var dataLayers = [jhuLayer, newsLayer, twitterLayer];

document.getElementById("end_date").valueAsDate = new Date();
downloadData();

function downloadData() {
    twitterLayer.updateLayer();
    newsLayer.updateLayer();

    dataStartDate = document.getElementById("start_date").valueAsDate;
    displayStartDate = dateToEpochMins(dataStartDate);
    dataEndDate = document.getElementById("end_date").valueAsDate;
    displayEndDate = dateToEpochMins(dataEndDate);

    var min = dateToEpochMins(dataStartDate)
    var max = dateToEpochMins(dataEndDate)

    $("#slider-range").slider("option", "min", min);
    $("#slider-range").slider("option", "max", max);

    setDisplayedDateRange(min, max);
}

//TODO: make this a binary search since that's definitely more efficient. To bad
// I'm too lazy to do it right the first time. Well, it seems to work as is,
// so why do more work than I have to? Make this change if it's too slow.
function nodeIndexOfTime(list, time) {
    var index = list.findIndex(function (e) {
        return e.time >= time;
    });
    if (index == -1) {
        return list.length - 1;
    } else {
        return index;
    }
}

// 99% sure this isn't the correct way to do this, but I can't be bothered to
// learn proper threading in JS. Not sure it even exists. This looks like it
// works though.
var animating = false;
async function animateMarkers() {
  if (!animating) {
    document.getElementById("animate").innerHTML = 'Pause Animation';
    animating = true;

    var start;
    var i;
    if(animation_paused) {
        if(cumulativeAnimation) {
            start = dateToEpochMins(dataStartDate);
            i = displayEndDate;
        } else {
            start = displayStartDate;
            i = start;
        }
    } else {
        start = dateToEpochMins(dataStartDate);
        i = start
    }
    for (;animating && i < dateToEpochMins(dataEndDate) - animateWindow; i+=animateStep) {

      if(cumulativeAnimation){
        setDisplayedDateRange(start, i+animateWindow);
      } else {
        setDisplayedDateRange(i, i+animateWindow);
      }

      await new Promise(r => setTimeout(r, animateSpeed));
    }
    if(animating){
        terminateAnimation();
    }
  } else {
    pauseAnimation();
  }
}

function pauseAnimation() {
    animating = false;
    animation_paused = true;
    document.getElementById("animate").innerHTML = 'Resume Animation &raquo;';
}

// Since I'm doing a bit of a hack here, the least I can do is hide it in function.
function terminateAnimation() {
    animating = false;
    animation_paused = false;
    document.getElementById("animate").innerHTML = 'Start Animation &raquo;';
}

function markerSize(clusterSize) {
  return 40 + Math.log(2*clusterSize)**2;
}

function dateToEpochMins(date) {
    return date.getTime() / (1000 * 60);
}

function epochMinsToDate(mins) {
    return new Date(mins * 60 * 1000);
}

function updateProgressBar(processed, total, elapsed, layersArray) {
    var progress = document.getElementById('progress');
    var progressBar = document.getElementById('progress-bar');

    if (elapsed > 500) {
        // if it takes more than half a second to load, display the progress bar:
        progress.style.display = 'block';
        progressBar.style.width = Math.round(processed/total*100) + '%';
    }

    if (processed === total) {
        // all markers processed - hide the progress bar:
        progress.style.display = 'none';
    }
}

function setAnimateWindow(size) {
    var startDate;
    var endDate;
    if (size == "max") {
        startDate = dateToEpochMins(document.getElementById("start_date").valueAsDate);
        endDate = dateToEpochMins(document.getElementById("end_date").valueAsDate);
        animateWindow = endDate - startDate;
    } else {
        animateWindow = parseInt(size);
        startDate = displayStartDate;
        endDate = startDate + animateWindow;
    }
    setDisplayedDateRange(startDate, endDate);
}

function setDisplayedDateRange(startMins, endMins) {
    displayEndDate = endMins;
    displayStartDate = startMins;

    // Set UI controls to reflect these values
    document.getElementById("display_start_date").valueAsDate = epochMinsToDate(startMins);
    document.getElementById("display_end_date").valueAsDate = epochMinsToDate(endMins);
    $("#slider-range").slider("values", [startMins, endMins]);

    // Update all layeres for new range
    newsLayer.plotData(startMins, endMins);
    twitterLayer.plotData(startMins, endMins);
    jhuLayer.plotData(startMins, endMins);

    if(selected_marker){
        info.updateForMarker(selected_marker);
    }
}

function setAnimateStep(step) {
    animateStep = parseInt(step);
}

function setAnimateSpeed(speed) {
    animateSpeed = parseInt(speed);
}

function toggleCumulative() {
    cumulativeAnimation = ! cumulativeAnimation;
    document.getElementById("animate_window").disabled = cumulativeAnimation;
}

function stepForward() {
    var current_end = displayEndDate; 
    current_end += animateStep;
    var current_start = displayStartDate;
    if(!cumulativeAnimation){
        current_start += animateStep;
    }
    setDisplayedDateRange(current_start, current_end);
}

function stepBack() {
    var current_end = displayEndDate; 
    current_end -= animateStep;
    var current_start = displayStartDate;
    if(!cumulativeAnimation){
        current_start -= animateStep;
    }
    setDisplayedDateRange(current_start, current_end);
}

function setCountryView(country_code) {
    bb = bounding_boxes[country_code][1];
    map.fitBounds([[bb[1], bb[0]], [bb[3], bb[2]]]);
}
